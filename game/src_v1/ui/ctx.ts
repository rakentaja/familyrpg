// What screens get from the app shell.
import type { BoardView } from '../contracts';
import type { Pack } from '../engine/types';
import type { AppStore } from '../store';

export interface Ctx {
  pack: Pack;
  board: BoardView;
  root: HTMLElement;
  store: AppStore | null;
  readonly me: string;
  /** 0..1 model loading progress, and a promise for when the board is ready. */
  boardProgress: number;
  boardReady: Promise<void>;
  onBoardProgress(cb: (p: number) => void): void;
  hostOnline(): Promise<void>;
  join(code: string): Promise<void>;
  playLocal(): Promise<void>;
  leave(): void;
  playAgain(): void;
}
