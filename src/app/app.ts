import { Component, computed, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

type TabId = 'archivos' | 'movimientos' | 'resumen';

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
    { id: 'resumen' as TabId, label: 'Resumen', icon: '∑' },
  ];

  protected readonly activeTab = signal<TabId>('archivos');
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
  protected readonly sortOrder = signal<'date-desc' | 'date-asc'>('date-desc');
  protected readonly selectedIds = signal<Set<string>>(new Set());

  private idSeq = Date.now();

  protected readonly allMovements = computed(() => {
    const selected = this.selectedFileIds();
    return this.files().filter((f) => selected.has(f.id)).flatMap((f) => f.movements);
  });

  protected readonly filteredMovements = computed(() => {
    const q = this.search().trim().toLowerCase();
    const from = this.parseInputDate(this.dateFrom());
    const to = this.parseInputDate(this.dateTo(), true);
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
    return [...list].sort((a, b) => {
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

  protected readonly totalAllFiltered = computed(() => this.filteredMovements().reduce((s, m) => s + m.amount, 0));

  protected setTab(id: TabId) { this.activeTab.set(id); }
  protected openFilter() { this.filterOpen.set(true); }
  protected closeFilter() { this.filterOpen.set(false); }
  protected setFilter(v: 'todos' | 'debitos' | 'creditos') { this.filter.set(v); }
  protected onSearch(v: string) { this.search.set(v); }
  protected onDateFrom(v: string) { this.dateFrom.set(v); }
  protected onDateTo(v: string) { this.dateTo.set(v); }
  protected toggleSort() {
    this.sortOrder.update((s) => (s === 'date-desc' ? 'date-asc' : 'date-desc'));
  }

  protected isFileSelected(id: string) { return this.selectedFileIds().has(id); }
  protected toggleFileSelection(id: string) {
    this.selectedFileIds.update((set) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    this.selectedIds.set(new Set());
  }
  protected selectAllFiles() { this.selectedFileIds.set(new Set(this.files().map((f) => f.id))); this.selectedIds.set(new Set()); }
  protected clearFileSelection() { this.selectedFileIds.set(new Set()); this.selectedIds.set(new Set()); }
  protected removeFile(id: string) {
    this.files.update((list) => list.filter((f) => f.id !== id));
    this.selectedFileIds.update((set) => { const n = new Set(set); n.delete(id); return n; });
    this.selectedIds.set(new Set());
    this.saveFiles();
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
      const rows = await this.extractRows(file);
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
        movements: movements.map((m) => ({ ...m, fileId, fileName: file.name, id: this.newId('mov') })),
      };
      this.files.update((list) => [stored, ...list]);
      this.selectedFileIds.update((set) => { const n = new Set(set); n.add(fileId); return n; });
      this.pendingFileName.set(null);
      this.rawRows.set([]);
      this.pendingMovements.set([]);
      this.saveFiles();
      this.activeTab.set('movimientos');
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

  // --- Parsing logic kept compatible with the working version ---
  private async extractRows(file: File): Promise<RawRow[]> {
    const pdfjsLib: any = await import('pdfjs-dist');
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      try {
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url' as any);
        pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default || worker;
      } catch {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '';
      }
    }

    const data = await file.arrayBuffer();
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
          return { str, x: tr[4] as number, y: tr[5] as number };
        })
        .filter((it) => it.str.length > 0);

      const lines = new Map<number, { x: number; str: string }[]>();
      for (const it of items) {
        const yKey = Math.round(it.y);
        let bucketKey = yKey;
        for (const key of lines.keys()) {
          if (Math.abs(key - yKey) <= 2) { bucketKey = key; break; }
        }
        if (!lines.has(bucketKey)) lines.set(bucketKey, []);
        lines.get(bucketKey)!.push({ x: it.x, str: it.str });
      }

      const sortedYs = [...lines.keys()].sort((a, b) => b - a);
      for (const y of sortedYs) {
        const parts = lines.get(y)!.sort((a, b) => a.x - b.x);
        const text = parts.map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const cells = this.splitCells(text);
        allRows.push({ cells, text });
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
        reference: findIdx(/refer/i, 1),
        description: findIdx(/descrip/i, 2),
        amount: findIdx(/monto/i, header.cells.length - 1),
      });
      return;
    }
    const max = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (max >= 4) {
      this.columnMap.set({ date: 0, reference: 1, description: 2, amount: max - 1 });
    } else if (max === 3) {
      this.columnMap.set({ date: 0, description: 1, amount: 2, reference: -1 });
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

    const isDate = (s: string) => /^(\d{1,2}[\/\-][A-Z]{3}[\/\-]\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})$/i.test(s.trim());
    const isMoney = (s: string) => /^[\$]?\s*-?[\d.,]+-?$/.test(s.trim());
    const fname = this.pendingFileName() || '';

    for (const row of rows) {
      const cells = row.cells;
      const get = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx].trim() : '');
      const date = get(map.date);
      const amountStr = get(map.amount);
      const desc = get(map.description);
      const ref = get(map.reference);

      if (isDate(date) && isMoney(amountStr)) {
        if (pending) { parsed.push(pending); pending = null; }
        const amount = this.parseAmount(amountStr);
        pending = { id: this.newId('mov'), fileId: '', fileName: fname, date, dateValue: this.parseStatementDate(date), reference: ref, description: desc, amount, raw: row.text };
      } else if (pending) {
        if (isMoney(amountStr) && !pending.description.includes(get(map.amount))) {
          // keep existing amount
        }
        const extra = [desc, ref, date].filter((s) => s && s !== pending!.description).join(' ').trim();
        if (extra && !/\bDETALLE|DESCRIPCI|FECHA\b/i.test(extra)) {
          pending.description = `${pending.description} ${extra}`.replace(/\s+/g, ' ').trim();
        }
      } else {
        if (isMoney(amountStr) && desc && !/\bDETALLE|DESCRIPCI|FECHA\b/i.test(row.text)) {
          const amount = this.parseAmount(amountStr);
          parsed.push({ id: this.newId('mov'), fileId: '', fileName: fname, date: date || '', dateValue: this.parseStatementDate(date), reference: ref, description: desc || row.text, amount, raw: row.text });
        }
      }
    }
    if (pending) parsed.push(pending);

    if (parsed.length === 0) {
      for (const row of rows) {
        const m = row.text.match(/^(\d{1,2}\/[A-Z]{3}\/\d{4})\s+(.*?)\s+(-?\$?[\d,.]+-?)$/i);
        if (m) {
          const [, date, rest, amt] = m;
          const parts = rest.trim().split(/\s{2,}|\s+/);
          const reference = parts.length > 1 && /^\d{6,}/.test(parts[0]) ? parts.shift()! : '';
          parsed.push({ id: this.newId('mov'), fileId: '', fileName: fname, date, dateValue: this.parseStatementDate(date), reference, description: parts.join(' '), amount: this.parseAmount(amt), raw: row.text });
        }
      }
    }

    this.pendingMovements.set(parsed);
  }

  private parseAmount(s: string): number {
    if (!s) return 0;
    let t = s.replace(/\$/g, '').replace(/\s/g, '').trim();
    let negative = false;
    if (t.endsWith('-')) { negative = true; t = t.slice(0, -1); }
    if (t.startsWith('-')) { negative = true; t = t.slice(1); }
    if (/,\d{3}/.test(t)) t = t.replace(/,/g, '');
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
