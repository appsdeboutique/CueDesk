/* Doble de prueba: un ConsoleLink falso que apunta lo que se envía y deja
 * inyectar mensajes entrantes como si los hubiera mandado la consola. */

import type { ConsoleLink, OscArgs, Unsubscribe } from "@cuedesk/console-adapter";

export interface FakeWrite {
  path: string;
  value: number | string;
  type: string | undefined;
}

export interface FakeLink extends ConsoleLink {
  sent: FakeWrite[];
  paths(): string[];
  values(): Array<number | string>;
  last(): FakeWrite | null;
  clear(): void;
  /** Inyecta un mensaje entrante de la consola. */
  receive(path: string, ...args: unknown[]): void;
}

export function fakeLink(): FakeLink {
  const sent: FakeWrite[] = [];
  const listeners = new Map<string, Set<(args: OscArgs, path: string) => void>>();

  const link: FakeLink = {
    sent: sent,

    send(path: string, value: number | string, type?: string): void {
      sent.push({ path: path, value: value, type: type });
    },

    on(pattern: string, fn: (args: OscArgs, path: string) => void): Unsubscribe {
      if (!listeners.has(pattern)) listeners.set(pattern, new Set());
      (listeners.get(pattern) as Set<(args: OscArgs, path: string) => void>).add(fn);
      return function off() {
        const set = listeners.get(pattern);
        if (set) set.delete(fn);
      };
    },

    receive(path: string, ...args: unknown[]): void {
      listeners.forEach(function (set, pattern) {
        const hit = pattern.endsWith("*")
          ? path.startsWith(pattern.slice(0, -1))
          : path === pattern;
        if (!hit) return;
        set.forEach(function (fn) { fn(args, path); });
      });
    },

    paths: function () { return sent.map(function (s) { return s.path; }); },
    values: function () { return sent.map(function (s) { return s.value; }); },
    last: function () { return sent.length ? sent[sent.length - 1] : null; },
    clear(): void { sent.length = 0; },
  };

  return link;
}
