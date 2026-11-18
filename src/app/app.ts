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

  // temporary import/mapping state
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
  protected readonly selectedIds = signal<Set<string>>(new Set());

  private idSeq = Date.now();

  protected readonly allMovements = computed(() => {
    const selected = this.selectedFileIds();
    return this.files()
      .filter((f) => selected.has(f.id))
      .flatMap((f) => f.movements);
  });

  protected readonly filteredMovements = computed(() => {
    const q = this.search().trim().toLowerCase();
    const from = this.parseInputDate(this.dateFrom());
    const to = this.parseInputDate(this.dateTo(), true);
    return this.allMovements().filter((m) => {
      if (this.filter() === 'debitos' && m.amount < 0) return false;
      if (this.filter() === 'creditos' && m.amount > 0) return false;
      if (q && !`${m.description} ${m.date} ${m.reference} ${m.fileName}`.toLowerCase().includes(q)) return false;
      if (from !== null && m.dateValue !== null && m.dateValue < from) return false;
      if (to !== null && m.dateValue !== null && m.dateValue > to) return false;
      if ((from !== null || to !== null) && m.dateValue === null) return false;
      return true;
    });
  });

  protected readonly selectedMovements = computed(() => {
    const ids = this.selectedIds();
    return this.filteredMovements().filter((m) => ids.has(m.id));
  });

  protected readonly selectionSummary = computed(() => {
    const items = this.selectedMovements();
    let debits = 0;
    let credits = 0;
    for (const m of items) {
      if (m.amount >= 0) debits += m.amount;
      else credits += m.amount;
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

  protected isFileSelected(id: string) { return this.selectedFileIds().has(id); }
  protected toggleFileSelection(id: string) {
    this.selectedFileIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    this.selectedIds.set(new Set());
  }
  protected selectAllFiles() {
    this.selectedFileIds.set(new Set(this.files().map((f) => f.id)));
    this.selectedIds.set(new Set());
  }
  protected clearFileSelection() {
    this.selectedFileIds.set(new Set());
    this.selectedIds.set(new Set());
  }

  protected removeFile(id: string) {
    this.files.update((list) => list.filter((f) => f.id !== id));
    this.selectedFileIds.update((set) => { const n = new Set(set); n.delete(id); return n; });
    this.selectedIds.set(new Set());
    this.saveFiles();
  }

  protected isSelected(id: string) { return this.selectedIds().has(id); }
  protected toggleSelection(id: string) {
    this.selectedIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  protected selectVisible() {
    const ids = this.filteredMovements().map((m) => m.id);
    this.selectedIds.update((set) => { const next = new Set(set); ids.forEach((id) => next.add(id)); return next; });
  }
  protected clearSelection() { this.selectedIds.set(new Set()); }

  protected async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set(null);
    this.loading.set(true);
    this.pendingFileName.set(file.name);
    try {
      const rows = await this.extractRows(file);
      this.rawRows.set(rows);
      this.autoDetectMap(rows);
      this.applyPendingMapping();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'No se pudo leer el PDF.');
    } finally {
      this.loading.set(false);
      input.value = '';
    }
  }

  protected savePendingAsStatement() {
    const name = this.pendingFileName();
    const movements = this.pendingMovements();
    if (!name || movements.length === 0) {
      this.error.set('No hay movimientos para guardar. Ajustá el mapeo y aplicalo primero.');
      return;
    }
    const fileId = this.newId('file');
    const stored: StatementFile = {
      id: fileId,
      name,
      importedAt: new Date().toISOString(),
      movements: movements.map((m) => ({ ...m, fileId, fileName: name, id: this.newId('mov') })),
    };
    this.files.update((list) => [stored, ...list]);
    this.selectedFileIds.update((set) => { const n = new Set(set); n.add(fileId); return n; });
    this.pendingFileName.set(null);
    this.rawRows.set([]);
    this.pendingMovements.set([]);
    this.saveFiles();
    this.activeTab.set('movimientos');
  }

  protected cancelPending() {
    this.pendingFileName.set(null);
    this.rawRows.set([]);
    this.pendingMovements.set([]);
    this.error.set(null);
  }

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
    const pdf = await pdfjsLib.getDocument({ data }).promise;
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
        for (const key of lines.keys()) { if (Math.abs(key - yKey) <= 2) { bucketKey = key; break; } }
        if (!lines.has(bucketKey)) lines.set(bucketKey, []);
        lines.get(bucketKey)!.push({ x: it.x, str: it.str });
      }
      const sortedYs = [...lines.keys()].sort((a, b) => b - a);
      for (const y of sortedYs) {
        const parts = lines.get(y)!.sort((a, b) => a.x - b.x);
        const text = parts.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const cells = /\s{2,}/.test(text) ? text.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean) : [text.trim()];
        allRows.push({ cells, text });
      }
    }
    return allRows;
  }

  private autoDetectMap(rows: RawRow[]) {
    const header = rows.find((r) => /fecha/i.test(r.text) && /descrip/i.test(r.text) && /monto/i.test(r.text));
    if (header && header.cells.length >= 3) {
      const findIdx = (re: RegExp, fb: number) => { const i = header.cells.findIndex((c) => re.test(c)); return i >= 0 ? i : fb; };
      this.columnMap.set({
        date: findIdx(/fecha/i, 0),
        reference: findIdx(/refer/i, 1),
        description: findIdx(/descrip/i, 2),
        amount: findIdx(/monto/i, header.cells.length - 1),
      });
      return;
    }
    const max = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (max >= 4) this.columnMap.set({ date: 0, reference: 1, description: 2, amount: max - 1 });
    else if (max === 3) this.columnMap.set({ date: 0, description: 1, amount: 2, reference: -1 });
  }

  protected updateMap<K extends keyof ColumnMap>(key: K, value: number) { this.columnMap.update((m) => ({ ...m, [key]: value })); }
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
        if (pending) parsed.push(pending);
        pending = { id: this.newId('mov'), fileId: '', fileName: fname, date, dateValue: this.parseStatementDate(date), reference: ref, description: desc, amount: this.parseAmount(amountStr), raw: row.text };
      } else if (pending) {
        const extra = [desc, ref, date].filter((s) => s && s !== pending!.description).join(' ').trim();
        if (extra && !/\bDETALLE|DESCRIPCI|FECHA\b/i.test(extra)) {
          pending.description = `${pending.description} ${extra}`.replace(/\s+/g, ' ').trim();
        }
      } else if (isMoney(amountStr) && desc && !/\bDETALLE|DESCRIPCI|FECHA\b/i.test(row.text)) {
        parsed.push({ id: this.newId('mov'), fileId: '', fileName: fname, date: date || '', dateValue: this.parseStatementDate(date), reference: ref, description: desc || row.text, amount: this.parseAmount(amountStr), raw: row.text });
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
    let neg = false;
    if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
    if (t.startsWith('-')) { neg = true; t = t.slice(1); }
    if (/,\d{3}/.test(t)) t = t.replace(/,/g, ''); else t = t.replace(/,/g, '.');
    const n = parseFloat(t);
    const val = isNaN(n) ? 0 : n;
    return neg ? -Math.abs(val) : val;
  }

  private parseStatementDate(s: string): number | null {
    if (!s) return null;
    const m = s.trim().match(/^(\d{1,2})[\/\-]([A-Z]{3}|\d{1,2})[\/\-](\d{2,4})$/i);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const monStr = m[2].toUpperCase();
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    const months: Record<string, number> = { ENE:0,FEB:1,MAR:2,ABR:3,MAY:4,JUN:5,JUL:6,AGO:7,SEP:8,OCT:9,NOV:10,DIC:11 };
    let month = months[monStr];
    if (month === undefined) { month = parseInt(monStr, 10) - 1; }
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.files())); } catch (e) { this.error.set('No se pudo guardar en almacenamiento local.'); }
  }
}
