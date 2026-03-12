/** @module Weighted LLM endpoint routing helpers */

export class WeightedRoundRobinSelector<T extends { weight: number }> {
  private readonly states: Array<{ item: T; currentWeight: number }>;
  private readonly totalWeight: number;

  constructor(items: T[]) {
    if (items.length === 0) {
      throw new Error("WeightedRoundRobinSelector requires at least one item");
    }

    for (const item of items) {
      if (!Number.isFinite(item.weight) || item.weight <= 0) {
        throw new Error("WeightedRoundRobinSelector items must have a positive weight");
      }
    }

    this.states = items.map((item) => ({ item, currentWeight: 0 }));
    this.totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  }

  next(): T {
    let selected = this.states[0];
    if (!selected) {
      throw new Error("WeightedRoundRobinSelector has no items");
    }

    for (const state of this.states) {
      state.currentWeight += state.item.weight;
      if (state.currentWeight > selected.currentWeight) {
        selected = state;
      }
    }

    selected.currentWeight -= this.totalWeight;
    return selected.item;
  }
}
