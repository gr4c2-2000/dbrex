/**
 * Provider registry.
 *
 * The only place that knows which providers exist. Everything else asks for one
 * by id and reads its capabilities — there is no `switch (kind)` anywhere else
 * in the daemon, which is the property that makes adding a data source a
 * one-file change instead of a hunt through eight of them.
 */

import type { Provider } from '@dbrex/core';
import { DbRexError } from '@dbrex/core';

export class ProviderRegistry {
  private readonly byId = new Map<string, Provider>();

  constructor(providers: readonly Provider[]) {
    for (const provider of providers) {
      if (this.byId.has(provider.id)) {
        throw new DbRexError('internal', `two providers claim the id "${provider.id}"`);
      }
      this.byId.set(provider.id, provider);
    }
  }

  get(id: string): Provider | undefined {
    return this.byId.get(id);
  }

  require(id: string): Provider {
    const provider = this.byId.get(id);
    if (!provider) {
      throw new DbRexError('config', `unknown connection kind "${id}"`, {
        hint: `available kinds: ${this.ids().join(', ')}`,
      });
    }
    return provider;
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  all(): Provider[] {
    return [...this.byId.values()];
  }
}
