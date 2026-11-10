// What screens get from the app shell.
import type { SceneView } from '../contracts';
import type { Pack } from '../rules/types';
import type { AppStore } from '../store';

export interface Ctx {
  pack: Pack;
  scene: SceneView;
  root: HTMLElement;
  store: AppStore | null;
  readonly me: string;
  /** 0..1 model loading progress, and a promise for when the scene is ready. */
  readonly sceneProgress: number;
  sceneReady: Promise<void>;
  onSceneProgress(cb: (p: number) => void): () => void;
  hostOnline(): Promise<void>;
  join(code: string): Promise<void>;
  playLocal(): Promise<void>;
  leave(): void;
  playAgain(): void;
}
