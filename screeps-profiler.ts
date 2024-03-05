let usedOnStart = 0;
let enabled = false;
let depth = 0;

declare var _: typeof import('lodash');

declare global {
  interface Function {
    [WRAPPED]?: true;
  }

  interface Memory {
    profiler?: ProfilerMemory;
  }

  interface Game {
    profiler: Readonly<ProfilerController>;
  }
}

export interface ProfilerMemory {
  disableTick?: number;

  enabledTick: number;

  filter?: string;

  map: Record<string, ProfilerFunctionStats>;

  totalTime: number;

  type: ProfileType;
}

export interface ProfilerController {
  /** This will run indefinitely, and will only output data when the `output` console command is run.  Very useful for long running profiles with lots of function calls. */
  background(filter?: string): void;

  /** This will run for the given number of ticks, and will email the output to your registered Screeps email address.  Very useful for long running profiles. */
  email(duration?: number, filter?: string): void;

  /** Print a report based on the current tick.  The profiler will continue to operate normally. This is currently the only way to get data from the `background` profile. */
  output(charLimit?: number): string;

  /** Will run for the given number of ticks then will output the gathered information to the console. */
  profile(duration?: number, filter?: string): void;

  /** Stops the profiler and resets its memory.  This is currently the only way to stop a `background` profile. */
  reset(): void;

  /** Restarts the profiler using the same options previously used to start it. */
  restart(): void;

  /** Will run for the given number of ticks, and will output the gathered information each tick to the console.  The can sometimes be useful for seeing spikes in performance. */
  stream(duration?: number, filter?: string): void;
}

export const enum ProfileType {
  Stream = 'stream',
  Email = 'email',
  Profile = 'profile',
  Background = 'background',
}

export interface ProfilerFunctionStats {
  calls: number;

  time: number;
}

type AnyFn = (...args: readonly any[]) => any;
const WRAPPED: unique symbol = Symbol('Wrapped');

export class AlreadyWrappedError extends Error {
  public constructor(what: string) {
    super(`Attempted to double wrap ${what}`);
    this.name = 'AlreadyWrappedError';
  }
}

export function enable(): void {
  if (enabled) {
    console.log('Profiler already enabled');
    return;
  }

  for (const [obj, name] of [
    [Room.prototype, 'Room'],
    [Creep.prototype, 'Creep'],
    [Structure.prototype, 'Structure'],
    [RoomPosition.prototype, 'RoomPosition'],
    [RoomVisual.prototype, 'RoomVisual'],
    [Spawn.prototype, 'Spawn'],
    [Source.prototype, 'Source'],
    [Flag.prototype, 'Flag'],
    [Game, 'Game'],
    [PathFinder, 'PathFinder'],
    [Game.map, 'Map']
  ] satisfies [object, string][]) {
    profileObject(name, obj);
  }
  enabled = true;
}

export function wrap(tickFunction: VoidFunction): void {
  if (!enabled) {
    return tickFunction();
  }

  setUpProfiler();

  if (!isProfiling()) {
    return tickFunction();
  }

  usedOnStart = Game.cpu.getUsed();
  tickFunction();
  endTick();
}

export function profileObject<T extends object>(label: string, obj: T): T {
  const descriptors = Object.getOwnPropertyDescriptors(obj);

  for (const prop in descriptors) {
    if (BLACKLIST.has(prop)) {
      continue;
    }

    const descriptor = descriptors[prop]!;
    if (typeof descriptor.value === 'function') {
    }

    if (descriptor.get || descriptor.set) {
      const overrides: Partial<Pick<PropertyDescriptor, 'get' | 'set'>> = {};

      if (descriptor.get) {
        overrides.get = profileFn(descriptor.get, `${label}.${prop}:get`);
      }
      if (descriptor.set) {
        overrides.set = profileFn(descriptor.set, `${label}.${prop}:set`);
      }

      Object.defineProperty(obj, prop, {...descriptor, ...overrides});
    } else if (typeof descriptor.value === 'function') {
      Object.defineProperty(obj, prop, {
        ...descriptor,
        value: profileFn(descriptor.value, `${label}.${prop}`)
      });
    }
  }

  return obj;
}

export function profileClass<T extends Function>(clazz: T, name: string = clazz.name): T {
  profileObject(name, clazz.prototype);

  return profileObject(`static:${name}`, clazz);
}

export function profileFn<F extends AnyFn>(originalFunction: F, name: string = originalFunction.name): F {
  if (originalFunction[WRAPPED]) {
    throw new AlreadyWrappedError(name);
  }

  function wrappedFunction(this: ThisType<F>, ...args: Parameters<F>): ReturnType<F> {
    if (!isProfiling()) {
      return originalFunction.apply(this, args);
    }

    const nameMatchesFilter = name === Memory.profiler!.filter;
    const start = Game.cpu.getUsed();
    if (nameMatchesFilter) {
      ++depth;
    }

    const result = originalFunction.apply(this, args);
    if (depth > 0 || !Memory.profiler!.filter) {
      record(name, Game.cpu.getUsed() - start);
    }

    if (nameMatchesFilter) {
      --depth;
    }

    return result;
  }

  Object.defineProperty(wrappedFunction, WRAPPED, {value: true});
  Object.defineProperty(wrappedFunction, 'name', {value: name});

  return wrappedFunction as F;
}

interface StatLine {
  calls: number;

  name: string;

  timeAvg: number;

  timeTotal: number;
}

function getStatLines(): StatLine[] {
  const out: StatLine[] = [];

  for (const fnName in Memory.profiler!.map) {
    const {calls, time} = Memory.profiler!.map[fnName]!;
    out.push({
      name: fnName,
      calls,
      timeTotal: time,
      timeAvg: time / calls
    });
  }

  return out.sort((a, b) => b.timeTotal - a.timeTotal);
}

function tr({name, calls, timeTotal, timeAvg}: StatLine): string {
  return `\n${calls.toLocaleString()}\t\t${timeTotal.toFixed(1)}\t\t${timeAvg.toFixed(3)}\t\t${name}`;
}

function resetMemory(): void {
  delete Memory.profiler;
}

function isProfiling(): boolean {
  return enabled && Memory.profiler != null
    && (!Memory.profiler.disableTick || Game.time <= Memory.profiler.disableTick);
}

function setUpMemory(type: ProfileType, duration?: number, filter?: string): void {
  Memory.profiler = {
    map: {},
    totalTime: 0,
    enabledTick: Game.time + 1,
    type,
    filter
  };

  if (Number.isInteger(duration)) {
    Memory.profiler.disableTick = Game.time + duration!;
  }
}

const PER_TICK_PROFILER = Object.freeze<ProfilerController>({
  stream(duration = CREEP_LIFE_TIME, filter) {
    setUpMemory(ProfileType.Stream, duration, filter);
  },
  email(duration = CREEP_LIFE_TIME, filter) {
    setUpMemory(ProfileType.Email, duration, filter);
  },
  profile(duration = CREEP_LIFE_TIME, filter) {
    setUpMemory(ProfileType.Profile, duration, filter);
  },
  background(filter) {
    setUpMemory(ProfileType.Background, undefined, filter);
  },
  output(charLimit = 4000) {
    if (!Memory.profiler?.enabledTick) {
      return '<span style="color:darkred">Profiler not active</span>';
    }

    const endTick = Math.min(Memory.profiler.disableTick || Game.time, Game.time);
    const startTick = Memory.profiler.enabledTick + 1;
    const elapsedTicks = endTick - startTick;
    const avg = (Memory.profiler.totalTime / elapsedTicks).toFixed(3);
    const total = _.round(Memory.profiler.totalTime, 3).toLocaleString();
    const lines = getStatLines();

    const footer = `\n\nAvg: ${avg}\tTotal: ${total}\tTicks: ${elapsedTicks}`;
    let out = `Calls\t\tTime\t\tAvg\t\tFn`;
    let length = out.length + footer.length;

    for (let l = 0; l < lines.length; ++l) {
      const line = tr(lines[l]!);
      length += line.length;
      if (length > charLimit) {
        break;
      }

      out += line;
    }

    return `${out}${footer}`;
  },
  reset: resetMemory,
  restart() {
    if (!isProfiling()) {
      return;
    }

    /*
     * Calculate the original duration, profile is enabled on the tick after the first call,
     * so add 1.
     */
    const duration = Memory.profiler!.disableTick
      ? Memory.profiler!.disableTick - Memory.profiler!.enabledTick + 1
      : undefined;

    setUpMemory(Memory.profiler!.type, duration, Memory.profiler!.filter);
  }
});

function setUpProfiler(): void {
  depth = 0; // reset depth, this needs to be done each tick.
  Game.profiler = PER_TICK_PROFILER;
  overloadCpuCalc();
}

function shouldPrint(): boolean {
  return Memory.profiler!.type === ProfileType.Stream
    || (Memory.profiler!.type === ProfileType.Profile && Memory.profiler!.disableTick === Game.time);
}

function shouldEmail(): boolean {
  return Memory.profiler!.type === ProfileType.Email && Memory.profiler!.disableTick === Game.time;
}

function report(): void {
  if (shouldPrint()) {
    console.log(PER_TICK_PROFILER.output());
  } else if (shouldEmail()) {
    Game.notify(PER_TICK_PROFILER.output(1000));
  }
}

function endTick(): void {
  if (Game.time < Memory.profiler!.enabledTick) {
    return;
  }

  Memory.profiler!.totalTime += Game.cpu.getUsed();
  report();
}

function record(fnName: string, time: number): void {
  const stats = Memory.profiler!.map[fnName] ??= {calls: 0, time: 0};

  ++stats.calls;
  stats.time += time;
}

const overloadCpuCalc: VoidFunction = Game.rooms.sim
  ? (() => {
    usedOnStart = 0; // This needs to be reset, but only in the sim.
    Game.cpu.getUsed = function getUsed() {
      return performance.now() - usedOnStart;
    };
  })
  : _.noop;

const BLACKLIST = new Set<string>([
  'getUsed',
  'prototype'
]);
