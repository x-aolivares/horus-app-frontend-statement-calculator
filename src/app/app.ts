import { Component, computed, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

type TabId = 'movimientos' | 'resumen';

interface Movement {
  id: number;
  description: string;
  date: string;
  amount: number;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly tabs = [
    { id: 'movimientos' as TabId, label: 'Movimientos', icon: '☰' },
    { id: 'resumen' as TabId, label: 'Resumen', icon: '∑' },
  ];

  protected readonly activeTab = signal<TabId>('movimientos');
  protected readonly filterOpen = signal(false);
  protected readonly filter = signal<'todos' | 'mayores'>('todos');
  protected readonly snackbar = signal<{ message: string; item?: Movement } | null>(null);

  private nextId = 4;
  protected readonly movements = signal<Movement[]>([
    { id: 1, description: 'Supermercado', date: '2026-11-10', amount: 24.9 },
    { id: 2, description: 'Farmacia', date: '2026-11-11', amount: 12.5 },
    { id: 3, description: 'Suscripción', date: '2026-11-12', amount: 9.99 },
  ]);

  protected readonly filteredMovements = computed(() => {
    const items = this.movements();
    if (this.filter() === 'mayores') {
      return items.filter((m) => m.amount >= 15);
    }
    return items;
  });

  protected readonly total = computed(() =>
    this.filteredMovements().reduce((sum, m) => sum + m.amount, 0)
  );

  protected setTab(id: TabId) {
    this.activeTab.set(id);
  }

  protected openFilter() {
    this.filterOpen.set(true);
  }

  protected closeFilter() {
    this.filterOpen.set(false);
  }

  protected setFilter(value: 'todos' | 'mayores') {
    this.filter.set(value);
  }

  protected createMovement() {
    const item: Movement = {
      id: this.nextId++,
      description: 'Nuevo movimiento',
      date: new Date().toISOString().slice(0, 10),
      amount: 10,
    };
    this.movements.update((list) => [item, ...list]);
    this.snackbar.set({ message: 'Movimiento creado', item });
    window.setTimeout(() => {
      const current = this.snackbar();
      if (current?.item?.id === item.id) {
        this.snackbar.set(null);
      }
    }, 4000);
  }

  protected undoCreate() {
    const current = this.snackbar();
    if (!current?.item) return;
    this.movements.update((list) => list.filter((m) => m.id !== current.item!.id));
    this.snackbar.set(null);
  }

  protected formatAmount(value: number): string {
    return value.toFixed(2);
  }
}
