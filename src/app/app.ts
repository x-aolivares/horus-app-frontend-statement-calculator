import { Component, computed, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

type TabId = 'cargar' | 'movimientos' | 'resumen';

interface RawRow {
  cells: string[];
  text: string;
}

interface Movement {
  id: number;
  date: string;
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

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly tabs = [
    { id: 'cargar' as TabId, label: 'Cargar', icon: '↑' },
    { id: 'movimientos' as TabId, label: 'Movimientos', icon: '☰' },
    { id: 'resumen' as TabId, label: 'Resumen', icon: '∑' },
  ];

  protected readonly activeTab = signal<TabId>('cargar');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fileName = signal<string | null>(null);
  protected readonly rawRows = signal<RawRow[]>([]);
  protected readonly columnCount = computed(() => {
    const rows = this.rawRows();
    return rows.reduce((max, r) => Math.max(max, r.cells.length), 0);
  });

  protected readonly columnMap = signal<ColumnMap>({ date: 0, description: 2, amount: 3, reference: 1 });
  protected readonly movements = signal<Movement[]>([]);
  protected readonly filterOpen = signal(false);
  protected readonly filter = signal<'todos' | 'debitos' | 'creditos'>('todos');
  protected readonly search = signal('');
  private nextId = 1;

  protected readonly filteredMovements = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.movements().filter((m) => {
      if (this.filter() === 'debitos' && m.amount < 0) return false;
      if (this.filter() === 'creditos' && m.amount > 0) return false;
      if (q && !`${m.description} ${m.date} ${m.reference} ${m.raw}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  protected readonly total = computed(() =>
    this.filteredMovements().reduce((sum, m) => sum + m.amount, 0)
  );

  protected setTab(id: TabId) {
    this.activeTab.set(id);
  }

  protected openFilter() { this.filterOpen.set(true); }
  protected closeFilter() { this.filterOpen.set(false); }
  protected setFilter(value: 'todos' | 'debitos' | 'creditos') { this.filter.set(value); }
  protected onSearch(value: string) { this.search.set(value); }

  protected async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set(null);
    this.loading.set(true);
    this.fileName.set(file.name);
    try {
      const rows = await this.extractRows(file);
      this.rawRows.set(rows);
      this.autoDetectMap(rows);
      this.applyMapping();
      if (this.movements().length > 0) {
        this.activeTab.set('movimientos');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo leer el PDF.';
      this.error.set(msg);
    } finally {
      this.loading.set(false);
      input.value = '';
    }
  }

  private async extractRows(file: File): Promise<RawRow[]> {
    const pdfjsLib: any = await import('pdfjs-dist');
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      try {
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url' as any);
        pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default || worker;
      } catch {
        // Fallback: run without a separate worker if bundler URL import is unavailable.
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
    // Try to split by 2+ spaces first (layout-like), fallback to single spaces
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
      const map: ColumnMap = {
        date: findIdx(/fecha/i, 0),
        reference: findIdx(/refer/i, 1),
        description: findIdx(/descrip/i, 2),
        amount: findIdx(/monto/i, header.cells.length - 1),
      };
      this.columnMap.set(map);
      return;
    }
    // Heuristic for this statement: Date Ref Description Amount
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

  protected applyMapping() {
    const map = this.columnMap();
    const rows = this.rawRows();
    const parsed: Movement[] = [];
    let pending: Movement | null = null;

    const isDate = (s: string) => /^(\d{1,2}[\/\-][A-Z]{3}[\/\-]\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})$/i.test(s.trim());
    const isMoney = (s: string) => /^[\$]?\s*-?[\d.,]+-?$/.test(s.trim());

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
        pending = { id: this.nextId++, date, reference: ref, description: desc, amount, raw: row.text };
      } else if (pending) {
        // continuation line: likely extra description or wrapped amount info
        if (isMoney(amountStr) && !pending.description.includes(get(map.amount))) {
          // if amount appears on continuation in some forms, keep existing amount
        }
        const extra = [desc, ref, date].filter((s) => s && s !== pending!.description).join(' ').trim();
        if (extra && !/\bDETALLE|DESCRIPCI|FECHA\b/i.test(extra)) {
          pending.description = `${pending.description} ${extra}`.replace(/\s+/g, ' ').trim();
        }
      } else {
        // try to detect amount-only or special rows in this statement format
        if (isMoney(amountStr) && desc && !/\bDETALLE|DESCRIPCI|FECHA\b/i.test(row.text)) {
          const amount = this.parseAmount(amountStr);
          parsed.push({ id: this.nextId++, date: date || '', reference: ref, description: desc || row.text, amount, raw: row.text });
        }
      }
    }
    if (pending) parsed.push(pending);

    // Fallback specific to this statement: lines like "DD/MON/YYYY ... description ... $amount" or amount at end
    if (parsed.length === 0) {
      for (const row of rows) {
        const m = row.text.match(/^(\d{1,2}\/[A-Z]{3}\/\d{4})\s+(.*?)\s+(-?\$?[\d,.]+-?)$/i);
        if (m) {
          const [, date, rest, amt] = m;
          const parts = rest.trim().split(/\s{2,}|\s+/);
          const reference = parts.length > 1 && /^\d{6,}/.test(parts[0]) ? parts.shift()! : '';
          parsed.push({ id: this.nextId++, date, reference, description: parts.join(' '), amount: this.parseAmount(amt), raw: row.text });
        }
      }
    }

    this.movements.set(parsed);
  }

  private parseAmount(s: string): number {
    if (!s) return 0;
    let t = s.replace(/\$/g, '').replace(/\s/g, '').trim();
    let negative = false;
    if (t.endsWith('-')) { negative = true; t = t.slice(0, -1); }
    if (t.startsWith('-')) { negative = true; t = t.slice(1); }
    // remove thousands separators (commas) keeping decimal dot if present
    if (/,\d{3}/.test(t)) t = t.replace(/,/g, '');
    else t = t.replace(/,/g, '.');
    const n = parseFloat(t);
    const val = isNaN(n) ? 0 : n;
    return negative ? -Math.abs(val) : val;
  }

  protected formatAmount(value: number): string {
    const sign = value < 0 ? '-' : '';
    return `${sign}$${Math.abs(value).toFixed(2)}`;
  }

  protected indexOptions(): number[] {
    const c = this.columnCount();
    return Array.from({ length: Math.max(c, 4) }, (_, i) => i);
  }

  protected sampleCell(row: RawRow, idx: number): string {
    return row.cells[idx] ?? '';
  }
}
