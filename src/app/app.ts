import { Component, computed, effect, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

type TabId = 'archivos' | 'movimientos' | 'ajustes';

interface RawRow {
  cells: string[];
  text: string;
}

interface Movement {
  id: string;
  fileId: string;
  fileName: string;
  date: string;
  dateValue: number | null;
  reference: string;
  description: string;
  amount: number;
  raw: string;
}

interface ColumnMap {
  date: number;
  description: number;
  amount: number;
  reference: number;
}

interface StatementFile {
  id: string;
  name: string;
  importedAt: string;
  fingerprint?: string;
  movements: Movement[];
}

const STORAGE_KEY = 'horus-statement-files-v1';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly tabs = [
    { id: 'archivos' as TabId, label: 'Archivos', icon: '▤' },
    { id: 'movimientos' as TabId, label: 'Movimientos', icon: '☰' },
    { id: 'ajustes' as TabId, label: 'Ajustes', icon: '⚙' },
  ];

  protected readonly activeTab = signal<TabId>(this.loadTab());
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly files = signal<StatementFile[]>(this.loadFiles());
  protected readonly selectedFileIds = signal<Set<string>>(new Set(this.loadFiles().map((f) => f.id)));

  // pending import/mapping state
  protected readonly pendingFileName = signal<string | null>(null);
  protected readonly rawRows = signal<RawRow[]>([]);
  protected readonly columnCount = computed(() => this.rawRows().reduce((m, r) => Math.max(m, r.cells.length), 0));
  protected readonly columnMap = signal<ColumnMap>({ date: 0, description: 2, amount: 3, reference: 1 });
  protected readonly pendingMovements = signal<Movement[]>([]);

  // movement view state
  protected readonly filterOpen = signal(false);
  protected readonly filter = signal<'todos' | 'debitos' | 'creditos'>('todos');
  protected readonly search = signal('');
  protected readonly dateFrom = signal('');
  protected readonly dateTo = signal('');
  protected readonly dateMode = signal<'rango' | 'dia'>('rango');
  protected readonly dateSingle = signal('');
  protected readonly sortOrder = signal<'date-desc' | 'date-asc'>('date-desc');
  protected readonly selectedIds = signal<Set<string>>(new Set());
  protected readonly dark = signal<boolean>(this.loadTheme());

  // mobile patterns: snack bar (undo), swipe actions, pull to refresh
  protected readonly snackbar = signal<{ message: string; undo?: () => void } | null>(null);
  protected readonly swipedFileId = signal<string | null>(null);
  protected readonly pullDistance = signal(0);
  protected readonly refreshing = signal(false);
  private snackbarTimer: ReturnType<typeof setTimeout> | null = null;
  private pullStartY = 0;
  private pulling = false;
  private rowTouchX = 0;

  private themeEffect = effect(() => {
    const dark = this.dark();
    const root = document.documentElement;
    if (dark) root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem('horus-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  });

  private idSeq = Date.now();

  protected readonly allMovements = computed(() => {
    const selected = this.selectedFileIds();
    return this.files().filter((f) => selected.has(f.id)).flatMap((f) => f.movements);
  });

  protected readonly filteredMovements = computed(() => {
    const q = this.search().trim().toLowerCase();
    const single = this.dateMode() === 'dia';
    const from = single ? this.parseInputDate(this.dateSingle()) : this.parseInputDate(this.dateFrom());
    const to = single ? this.parseInputDate(this.dateSingle(), true) : this.parseInputDate(this.dateTo(), true);
    const list = this.allMovements().filter((m) => {
      if (this.filter() === 'debitos' && m.amount < 0) return false;
      if (this.filter() === 'creditos' && m.amount > 0) return false;
      if (q && !`${m.description} ${m.date} ${m.reference} ${m.fileName} ${m.raw}`.toLowerCase().includes(q)) return false;
      if (from !== null || to !== null) {
        if (m.dateValue === null) return false;
        if (from !== null && m.dateValue < from) return false;
        if (to !== null && m.dateValue > to) return false;
      }
      return true;
    });
    const dir = this.sortOrder() === 'date-desc' ? -1 : 1;
    return list.toSorted((a, b) => {
      const av = a.dateValue ?? -Infinity;
      const bv = b.dateValue ?? -Infinity;
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  });

  protected readonly selectedMovements = computed(() => {
    const ids = this.selectedIds();
    return this.allMovements().filter((m) => ids.has(m.id));
  });

  protected readonly selectionSummary = computed(() => {
    const items = this.selectedMovements();
    let debits = 0;
    let credits = 0;
    for (const m of items) {
      if (m.amount >= 0) debits += m.amount; else credits += m.amount;
    }
    return { count: items.length, debits, credits, net: debits + credits };
  });

  protected readonly totalMovements = computed(() => this.files().reduce((s, f) => s + f.movements.length, 0));

  protected setTheme(dark: boolean) { this.dark.set(dark); }
  protected clearAllData() {
    if (this.files().length === 0) return;
    if (!window.confirm('¿Borrar todos los archivos y movimientos?')) return;
    const backup = this.files();
    const backupSelection = this.selectedFileIds();
    this.files.set([]);
    this.selectedFileIds.set(new Set());
    this.selectedIds.set(new Set());
    this.saveFiles();
    this.notify('Datos borrados', () => {
      this.files.set(backup);
      this.selectedFileIds.set(backupSelection);
      this.saveFiles();
    });
  }

  protected setTab(id: TabId) { this.activeTab.set(id); this.saveTab(id); }

  private loadTab(): TabId {
    try {
      const saved = localStorage.getItem('horus-active-tab');
      if (saved === 'archivos' || saved === 'movimientos' || saved === 'ajustes') return saved;
    } catch { /* ignore */ }
    return 'archivos';
  }
  private saveTab(id: TabId) {
    try { localStorage.setItem('horus-active-tab', id); } catch { /* ignore */ }
  }
  protected openFilter() { this.filterOpen.set(true); }
  protected closeFilter() { this.filterOpen.set(false); }
  protected setFilter(v: 'todos' | 'debitos' | 'creditos') { this.filter.set(v); }
  protected onSearch(v: string) { this.search.set(v); }
  protected clearSearch() { this.search.set(''); }
  protected onDateFrom(v: string) { this.dateFrom.set(v); }
  protected onDateTo(v: string) { this.dateTo.set(v); }
  protected setDateMode(mode: 'rango' | 'dia') { this.dateMode.set(mode); }
  protected onDateSingle(v: string) { this.dateSingle.set(v); }
  protected readonly activeFilterCount = computed(() => {
    let n = 0;
    if (this.search().trim()) n++;
    if (this.filter() !== 'todos') n++;
    if (this.dateMode() === 'dia') {
      if (this.dateSingle()) n++;
    } else {
      if (this.dateFrom()) n++;
      if (this.dateTo()) n++;
    }
    return n;
  });
  protected clearAllFilters() {
    this.onSearch('');
    this.setFilter('todos');
    this.onDateFrom('');
    this.onDateTo('');
    this.onDateSingle('');
  }
  private loadTheme(): boolean {
    try {
      const saved = localStorage.getItem('horus-theme');
      if (saved === 'dark' || saved === 'light') return saved === 'dark';
    } catch { /* ignore */ }
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  }

  protected isFileSelected(id: string) { return this.selectedFileIds().has(id); }
  protected toggleFileSelection(id: string) {
    if (this.swipedFileId() === id) { this.swipedFileId.set(null); return; }
    this.selectedFileIds.update((set) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    this.selectedIds.set(new Set());
  }
  protected selectAllFiles() { this.selectedFileIds.set(new Set(this.files().map((f) => f.id))); this.selectedIds.set(new Set()); }
  protected clearFileSelection() { this.selectedFileIds.set(new Set()); this.selectedIds.set(new Set()); }
  protected removeFile(id: string) {
    const list = this.files();
    const index = list.findIndex((f) => f.id === id);
    if (index < 0) return;
    const removed = list[index];
    this.files.update((l) => l.filter((f) => f.id !== id));
    this.selectedFileIds.update((set) => { const n = new Set(set); n.delete(id); return n; });
    this.selectedIds.set(new Set());
    this.saveFiles();
    this.notify('Archivo eliminado', () => {
      this.files.update((l) => { const n = [...l]; n.splice(Math.min(index, n.length), 0, removed); return n; });
      this.selectedFileIds.update((set) => { const n = new Set(set); n.add(removed.id); return n; });
      this.saveFiles();
    });
  }

  protected notify(message: string, undo?: () => void) {
    if (this.snackbarTimer) clearTimeout(this.snackbarTimer);
    this.snackbar.set({ message, undo });
    this.snackbarTimer = setTimeout(() => this.snackbar.set(null), 5000);
  }

  protected onPullTouchStart(e: TouchEvent) {
    const content = e.currentTarget as HTMLElement;
    const target = e.target as HTMLElement | null;
    let atTop = content.scrollTop <= 0;
    if (this.activeTab() === 'movimientos') {
      const layout = content.querySelector('.movements-layout') as HTMLElement | null;
      const list = content.querySelector('.movements-list') as HTMLElement | null;
      if (!layout || !list) { this.pulling = false; return; }
      if (!target || !layout.contains(target)) { this.pulling = false; return; }
      atTop = list.scrollTop <= 0;
    }
    this.pulling = atTop && !this.refreshing();
    this.pullStartY = e.touches[0].clientY;
  }
  protected onPullTouchMove(e: TouchEvent) {
    if (!this.pulling || this.refreshing()) return;
    if (this.activeTab() === 'movimientos') {
      const content = e.currentTarget as HTMLElement;
      const list = content.querySelector('.movements-list') as HTMLElement | null;
      if (!list || list.scrollTop > 0) { this.pulling = false; this.pullDistance.set(0); return; }
    } else {
      const content = e.currentTarget as HTMLElement;
      if (content.scrollTop > 0) { this.pulling = false; this.pullDistance.set(0); return; }
    }
    const dy = e.touches[0].clientY - this.pullStartY;
    if (dy > 0) {
      try { e.preventDefault(); } catch { /* ignore passive listener */ }
      this.pullDistance.set(Math.min(Math.round(dy * 0.5), 56));
    } else {
      this.pullDistance.set(0);
    }
  }
  protected async onPullTouchEnd() {
    if (!this.pulling) return;
    this.pulling = false;
    if (this.pullDistance() < 48) { this.pullDistance.set(0); return; }
    this.refreshing.set(true);
    await new Promise((r) => setTimeout(r, 600));
    this.files.set(this.loadFiles());
    this.refreshing.set(false);
    this.pullDistance.set(0);
    this.notify('Actualizado');
  }

  protected onRowTouchStart(e: TouchEvent) {
    this.rowTouchX = e.touches[0].clientX;
  }
  protected onRowTouchMove(e: TouchEvent, id: string) {
    const dx = e.touches[0].clientX - this.rowTouchX;
    if (dx < -40) this.swipedFileId.set(id);
    else if (dx > 40 && this.swipedFileId() === id) this.swipedFileId.set(null);
  }

  protected isSelected(id: string) { return this.selectedIds().has(id); }
  protected toggleSelection(id: string) {
    this.selectedIds.update((set) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  protected selectVisible() {
    const ids = this.filteredMovements().map((m) => m.id);
    this.selectedIds.update((set) => { const n = new Set(set); ids.forEach((id) => n.add(id)); return n; });
  }
  protected clearSelection() { this.selectedIds.set(new Set()); }

  protected async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set(null);
    this.loading.set(true);
    try {
      const data = await file.arrayBuffer();
      const fingerprint = await this.hashBuffer(data);
      const duplicate = this.files().find((f) =>
        f.fingerprint ? f.fingerprint === fingerprint : f.name === file.name,
      );
      if (duplicate) {
        this.error.set('Este archivo ya fue importado.');
        return;
      }

      const rows = await this.extractRows(data);
      this.rawRows.set(rows);
      this.pendingFileName.set(file.name);
      this.autoDetectMap(rows);
      this.applyPendingMapping();
      const movements = this.pendingMovements();
      if (movements.length === 0) {
        this.error.set('No se pudieron detectar movimientos en el archivo.');
        this.cancelPending();
        return;
      }
      const fileId = this.newId('file');
      const stored: StatementFile = {
        id: fileId,
        name: file.name,
        importedAt: new Date().toISOString(),
        fingerprint,
        movements: movements.map((m) => ({ ...m, fileId, fileName: file.name, id: this.newId('mov') })),
      };
      this.files.update((list) => [stored, ...list]);
      this.selectedFileIds.update((set) => { const n = new Set(set); n.add(fileId); return n; });
      this.pendingFileName.set(null);
      this.rawRows.set([]);
      this.pendingMovements.set([]);
      this.saveFiles();
      this.setTab('movimientos');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo leer el PDF.';
      this.error.set(msg);
      this.cancelPending();
    } finally {
      this.loading.set(false);
      input.value = '';
    }
  }

  protected cancelPending() {
    this.pendingFileName.set(null);
    this.rawRows.set([]);
    this.pendingMovements.set([]);
  }

  // --- Parsing logic: supports multiple statement formats (retrocompatible) ---
  private async extractRows(data: ArrayBuffer): Promise<RawRow[]> {
    const pdfjsLib: any = await import('pdfjs-dist');
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      try {
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url' as any);
        pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default || worker;
      } catch {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '';
      }
    }

    const task = pdfjsLib.getDocument({ data });
    const pdf = await task.promise;
    const allRows: RawRow[] = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items as any[])
        .map((it) => {
          const str = String(it.str ?? '').replace(/\s+/g, ' ').trim();
          const tr = it.transform || [1, 0, 0, 1, 0, 0];
          const w = typeof it.width === 'number' && it.width > 0 ? (it.width as number) : Math.max(1, str.length) * 3;
          return { str, x: tr[4] as number, y: tr[5] as number, w };
        })
        .filter((it) => it.str.length > 0);

      const lines = new Map<number, { x: number; str: string; w: number }[]>();
      for (const it of items) {
        const yKey = Math.round(it.y);
        let bucketKey = yKey;
        for (const key of lines.keys()) {
          if (Math.abs(key - yKey) <= 2) { bucketKey = key; break; }
        }
        if (!lines.has(bucketKey)) lines.set(bucketKey, []);
        lines.get(bucketKey)!.push(it);
      }

      const sortedYs = [...lines.keys()].toSorted((a, b) => b - a);
      for (const y of sortedYs) {
        const parts = lines.get(y)!.sort((a, b) => a.x - b.x);
        const cells: string[] = [];
        let cellText = parts[0].str;
        let right = parts[0].x + parts[0].w;
        for (let i = 1; i < parts.length; i++) {
          const part = parts[i];
          const gap = part.x - right;
          // large horizontal gap => new column/cell; small gap => same text fragment
          if (gap > 10) {
            cells.push(cellText.trim());
            cellText = part.str;
          } else {
            cellText += ' ' + part.str;
          }
          right = Math.max(right, part.x + part.w);
        }
        cells.push(cellText.trim());
        const filtered = cells.map((c) => c.trim()).filter((c) => c.length > 0);
        if (!filtered.length) continue;
        const text = filtered.join('  ').replace(/\s+/g, ' ').trim();
        allRows.push({ cells: filtered, text });
      }
    }
    return allRows;
  }

  private splitCells(text: string): string[] {
    if (/\s{2,}/.test(text)) {
      return text.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    }
    return [text.trim()];
  }

  private autoDetectMap(rows: RawRow[]) {
    const header = rows.find((r) => /fecha/i.test(r.text) && /descrip/i.test(r.text) && /monto/i.test(r.text));
    if (header && header.cells.length >= 3) {
      const findIdx = (re: RegExp, fallback: number) => {
        const i = header.cells.findIndex((c) => re.test(c));
        return i >= 0 ? i : fallback;
      };
      this.columnMap.set({
        date: findIdx(/fecha/i, 0),
        reference: findIdx(/refer/i, -1),
        description: findIdx(/descrip/i, header.cells.length >= 2 ? 1 : 0),
        amount: findIdx(/monto/i, header.cells.length - 1),
      });
      return;
    }
    const max = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (max >= 4) {
      this.columnMap.set({ date: 0, reference: 1, description: 2, amount: max - 1 });
    } else if (max === 3) {
      this.columnMap.set({ date: 0, description: 1, amount: 2, reference: -1 });
    } else {
      this.columnMap.set({ date: 0, description: 1, amount: 1, reference: -1 });
    }
  }

  protected updateMap<K extends keyof ColumnMap>(key: K, value: number) {
    this.columnMap.update((m) => ({ ...m, [key]: value }));
  }

  protected applyPendingMapping() {
    const map = this.columnMap();
    const rows = this.rawRows();
    const parsed: Movement[] = [];
    let pending: Movement | null = null;
    let leadIn = '';

    const isDate = (s: string) => /^(\d{1,2}[\/\-][A-Z]{3}[\/\-]\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})$/i.test((s || '').trim());
    const isMoney = (s: string) => /^-?\$?\s*-?[\d.,]+-?$/.test((s || '').trim());
    const isHeaderLike = (t: string) =>
      /\bDETALLE\b|DESCRIPCI[OÓ]N|REFERENCIA|SALDO\s+TOTAL/i.test(t) ||
      (/^FECHA\b/i.test(t) && /MONTO/i.test(t)) ||
      /^informaci[oó]n (de|relevante)\b/i.test(t) ||
      /^notificaciones\b/i.test(t);
    const isSectionNoise = (t: string) =>
      /^(cargos y pagos|movimientos\b|planes de cr[eé]dito|plan de cr[eé]dito)\b/i.test(t) ||
      /pagos\s+\$[\d.,]+\s*[•·]\s*compras/i.test(t) ||
      /^deuda anterior\b/i.test(t) ||
      /^estado de cuenta\b/i.test(t) ||
      /^informaci[oó]n de (la )?cuenta\b/i.test(t) ||
      /^programa de puntos\b/i.test(t) ||
      /^puntos disponibles\b/i.test(t) ||
      /^resumen de estado\b/i.test(t) ||
      /^disponible\s+\$/i.test(t) ||
      /^(compras|pagos)\s+-?\$[\d.,]+\s*$/i.test(t);
    const fname = this.pendingFileName() || '';

    const headerRow = rows.find((r) => /fecha/i.test(r.text) && /descrip/i.test(r.text) && /monto/i.test(r.text));
    let saldoIdx = -1;
    if (headerRow) {
      saldoIdx = headerRow.cells.findIndex((c) => /saldo/i.test(c));
    }
    const hasSaldo = saldoIdx >= 0 && saldoIdx > map.amount;

    const rowInfo = (row: RawRow) => {
      const cells = row.cells;
      const get = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx].trim() : '');
      const rowText = row.text.trim();
      let date = get(map.date);
      let dateIdx = map.date;
      if (!isDate(date)) {
        const found = cells.findIndex((c) => isDate(c));
        if (found >= 0) { date = cells[found].trim(); dateIdx = found; }
      }
      let amountStr = get(map.amount);
      let amountIdx = map.amount;
      const moneyIdxs = cells.map((c, i) => (isMoney(c) ? i : -1)).filter((i) => i >= 0);
      if (!isMoney(amountStr)) {
        if (moneyIdxs.length > 0) {
          if (hasSaldo && moneyIdxs.length >= 2) amountIdx = moneyIdxs[moneyIdxs.length - 2];
          else amountIdx = moneyIdxs[moneyIdxs.length - 1];
          amountStr = cells[amountIdx].trim();
        }
      } else if (hasSaldo) {
        if (moneyIdxs.length >= 2 && amountIdx === moneyIdxs[moneyIdxs.length - 1]) {
          amountIdx = moneyIdxs[moneyIdxs.length - 2];
          amountStr = cells[amountIdx].trim();
        }
      }
      let saldoValueIdx = -1;
      if (hasSaldo && moneyIdxs.length >= 2) {
        saldoValueIdx = moneyIdxs[moneyIdxs.length - 1];
        if (saldoValueIdx === amountIdx && moneyIdxs.length >= 3) saldoValueIdx = moneyIdxs[moneyIdxs.length - 2];
      }
      let ref = '';
      if (map.reference >= 0 && map.reference < cells.length) {
        const r = cells[map.reference].trim();
        if (r && r !== date && r !== amountStr) ref = r;
      }
      let desc = '';
      if (map.description >= 0) {
        const start = Math.max(0, map.description);
        const end = amountIdx > start ? amountIdx : cells.length;
        const parts: string[] = [];
        for (let i = start; i < end && i < cells.length; i++) {
          if (i === dateIdx || i === amountIdx) continue;
          if (saldoValueIdx >= 0 && i === saldoValueIdx) continue;
          const cell = cells[i];
          if (typeof cell === 'string' && cell.trim()) parts.push(cell.trim());
        }
        desc = parts.join(' ').replace(/\s+/g, ' ').trim();
      }
      if (!desc) {
        desc = cells.filter((c, i) => i !== dateIdx && i !== amountIdx && i !== saldoValueIdx).join(' ').replace(/\s+/g, ' ').trim();
      }
      const dateCount = cells.filter((c) => isDate(c)).length;
      return { cells, rowText, date, dateIdx, amountStr, amountIdx, moneyIdxs, saldoValueIdx, ref, desc, dateCount };
    };

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const rowText = row.text.trim();
      if (!rowText) continue;

      if (isHeaderLike(rowText) || isSectionNoise(rowText)) {
        leadIn = '';
        continue;
      }
      if (/^\d+\s+de\s+\d+$/i.test(rowText) || /^\*{4,}[\d*]+$/.test(rowText.replace(/\s+/g, '')) || /^saldo anterior\b/i.test(rowText)) {
        leadIn = '';
        continue;
      }
      if (rowText.length > 140 && !/\d{1,2}[\/\-][A-Z]{3}[\/\-]\d{4}/i.test(rowText)) {
        leadIn = '';
        continue;
      }

      const info = rowInfo(row);
      const { cells, date, dateIdx, amountStr, amountIdx, moneyIdxs, saldoValueIdx, ref, desc, dateCount } = info;

      const isTxnRow = isDate(date) && isMoney(amountStr);
      if (isTxnRow) {
        const amount = this.parseAmount(amountStr);
        let fullDesc = [leadIn, desc].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        const summaryLike = moneyIdxs.length >= 4 || (dateCount >= 2 && moneyIdxs.length >= 3);
        const meaningful = /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(fullDesc.replace(/[-$]?[\d.,]+/g, '').trim());
        if (summaryLike || (!meaningful && !(hasSaldo && moneyIdxs.length >= 2))) {
          if (pending) { parsed.push(pending); pending = null; }
          leadIn = '';
          continue;
        }
        if (pending) { parsed.push(pending); pending = null; }
        leadIn = '';
        pending = {
          id: this.newId('mov'), fileId: '', fileName: fname,
          date, dateValue: this.parseStatementDate(date),
          reference: ref === desc ? '' : ref,
          description: fullDesc || desc || rowText,
          amount, raw: row.text,
        };
        // if description is missing (e.g. split into following line), try to pull next text-only line
        if (!meaningful) {
          const next = rows[ri + 1];
          if (next) {
            const nText = next.text.trim();
            const nInfo = rowInfo(next);
            const nIsTxn = isDate(nInfo.date) && isMoney(nInfo.amountStr);
            if (!nIsTxn && nText && !isHeaderLike(nText) && !isSectionNoise(nText) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(nText) && nText.length < 120) {
              pending.description = `${pending.description} ${nText}`.replace(/\s+/g, ' ').trim();
              ri++;
            }
          }
        }
        continue;
      }

      if (pending) {
        // if this is a text-only line and next row is a transaction that likely needs a lead-in (no desc), treat as lead-in
        const next = rows[ri + 1];
        if (next) {
          const nText = next.text.trim();
          const nInfo = rowInfo(next);
          const nIsTxn = isDate(nInfo.date) && isMoney(nInfo.amountStr);
          if (nIsTxn) {
            const nDesc = [nInfo.desc].filter(Boolean).join(' ').trim();
            const nMeaningful = /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(nDesc.replace(/[-$]?[\d.,]+/g, '').trim());
            const isTextOnly = !isDate(date) && moneyIdxs.length === 0 && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(rowText);
            if (isTextOnly && !nMeaningful && hasSaldo) {
              parsed.push(pending);
              pending = null;
              leadIn = [leadIn, rowText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
              continue;
            }
          }
        }

        const extra = rowText;
        if (!isHeaderLike(extra) && !isSectionNoise(extra) && !/^\d+\s+de\s+\d+$/i.test(extra)) {
          const stripped = extra.replace(/[-$]?[\d.,]+/g, '').replace(/[•·%]/g, '').trim();
          const moneyOnly = !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(stripped);
          const looksLikeNewSection = /^(saldo|total|disponible|l[ií]mite|fecha de|producto|n[°o]\s*cuenta|titular|informaci[oó]n|notificaciones|ruc|tasa|inter[eé]s|estimado cliente)/i.test(extra);
          const looksLikeSummary = /^(compras|pagos|cargos|débitos|cr[eé]ditos)\b/i.test(extra);
          const tooLong = extra.length > 120;
          const looksLegal = /reclamos|llamando al|d[ií]as h[aá]biles|se entender[aá]|ser[aá]n actualizadas|para su conveniencia|seg[uú]n lo establece|banco general,\s*s\.a\./i.test(extra);
          const looksDocHeader = /^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+\d{4}$/i.test(extra.trim()) || /pago de contado|fecha l[ií]mite/i.test(extra) || (extra === extra.toUpperCase() && /^[A-ZÁÉÍÓÚÑ\s.]{12,}$/.test(extra));
          if (!moneyOnly && !looksLikeNewSection && !looksLikeSummary && !tooLong && !looksLegal && !looksDocHeader) {
            pending.description = `${pending.description} ${extra}`.replace(/\s+/g, ' ').trim();
          }
        }
        continue;
      }

      // no pending
      if (!isDate(date) && moneyIdxs.length === 0 && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(rowText)) {
        const looksMeta = /[:]/.test(rowText) && /(cuenta|titular|disponible|l[ií]mite|corte|pago|producto|planilla|email|puntos|programa)/i.test(rowText);
        const looksTitle = rowText === rowText.toUpperCase() && rowText.length > 20;
        if (!looksMeta && !looksTitle && rowText.length < 80) {
          leadIn = [leadIn, rowText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        } else {
          leadIn = '';
        }
      } else {
        leadIn = '';
      }
    }
    if (pending) parsed.push(pending);

    if (parsed.length === 0) {
      for (const row of rows) {
        const m = row.text.match(/^(\d{1,2}[\/\-][A-Z]{3}[\/\-]\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(.*?)\s+(-?\$?\s*[\d.,]+-?)\s*$/i);
        if (m) {
          const [, date, rest, amt] = m;
          const parts = rest.trim().split(/\s{2,}/);
          const tokens = parts.length > 1 ? parts : rest.trim().split(/\s+/);
          const reference = tokens.length > 1 && /^(\d[\d\s-]{4,})$/.test(tokens[0]) ? tokens.shift()! : '';
          parsed.push({ id: this.newId('mov'), fileId: '', fileName: fname, date, dateValue: this.parseStatementDate(date), reference, description: tokens.join(' ').replace(/\s+/g, ' ').trim(), amount: this.parseAmount(amt), raw: row.text });
        }
      }
    }

    this.pendingMovements.set(parsed);
  }

  private parseAmount(s: string): number {
    if (!s) return 0;
    let t = String(s).replace(/\$/g, '').replace(/\s/g, '').trim();
    let negative = false;
    if (/^-/.test(t) || /^-/.test(String(s).trim())) negative = true;
    if (t.startsWith('-')) t = t.slice(1);
    if (t.endsWith('-')) { negative = true; t = t.slice(0, -1); }
    if (t.startsWith('-')) { negative = true; t = t.slice(1); }
    if (/,\d{3}/.test(t)) t = t.replace(/,/g, '');
    else if (/\.\d{3}/.test(t) && /,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(/,/g, '.');
    else t = t.replace(/,/g, '.');
    const n = parseFloat(t);
    const val = isNaN(n) ? 0 : n;
    return negative ? -Math.abs(val) : val;
  }

  private parseStatementDate(s: string): number | null {
    if (!s) return null;
    const m = s.trim().match(/^(\d{1,2})[\/\-]([A-Z]{3}|\d{1,2})[\/\-](\d{2,4})$/i);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const monStr = m[2].toUpperCase();
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    const months: Record<string, number> = { ENE: 0, FEB: 1, MAR: 2, ABR: 3, MAY: 4, JUN: 5, JUL: 6, AGO: 7, SEP: 8, OCT: 9, NOV: 10, DIC: 11 };
    let month = months[monStr];
    if (month === undefined) month = parseInt(monStr, 10) - 1;
    if (isNaN(day) || isNaN(month) || month < 0 || isNaN(year)) return null;
    return new Date(year, month, day).getTime();
  }

  private parseInputDate(v: string, endOfDay = false): number | null {
    if (!v) return null;
    const d = new Date(v + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    if (endOfDay) d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  protected formatAmount(value: number): string {
    const sign = value < 0 ? '-' : '';
    return `${sign}$${Math.abs(value).toFixed(2)}`;
  }
  protected formatDate(ts: string): string {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }
  protected indexOptions(): number[] {
    const c = this.columnCount();
    return Array.from({ length: Math.max(c, 4) }, (_, i) => i);
  }

  private newId(prefix: string): string { return `${prefix}-${++this.idSeq}-${Math.random().toString(36).slice(2, 7)}`; }

  private async hashBuffer(data: ArrayBuffer): Promise<string> {
    if (globalThis.crypto?.subtle) {
      const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback fingerprint when SubtleCrypto is unavailable.
    const bytes = new Uint8Array(data);
    let h = `${bytes.byteLength}:`;
    const step = Math.max(1, Math.floor(bytes.byteLength / 256));
    for (let i = 0; i < bytes.byteLength; i += step) h += bytes[i].toString(16).padStart(2, '0');
    return h;
  }

  private loadFiles(): StatementFile[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  private saveFiles() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.files())); }
    catch { this.error.set('No se pudo guardar en almacenamiento local.'); }
  }
}
