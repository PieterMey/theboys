// Owner: track ⑤ Players. Emotes (T wheel -> 'players.emote'), silent pings (MMB raycast -> server LOS relay ->
// glowing marker for 3 s) and proximity text chat (Enter -> 'players.chat', delivered by talk-band path distance).
import * as THREE from 'three/webgpu';
import { signal } from '@preact/signals';
import { ANIM } from '@dead-air/shared/anim.ts';
import type { EmoteKind } from '@dead-air/shared/messages/players.ts';
import type { ClientContext } from '../core/context.ts';
import type { V3 } from './types.ts';
import type { StanceView } from './stealth.ts';

export const EMOTE_ANIM: Record<EmoteKind, number> = {
  wave: ANIM.emoteWave, point: ANIM.emotePoint, beckon: ANIM.emoteBeckon, thumbs: ANIM.emoteThumbs,
};
/** wheel layout: up, right, down, left */
export const WHEEL: EmoteKind[] = ['wave', 'point', 'thumbs', 'beckon'];
export const EMOTE_LABEL: Record<EmoteKind, string> = { wave: 'WAVE', point: 'POINT', beckon: 'BECKON', thumbs: 'THUMBS UP' };

export interface ChatLine { id: number; name: string; text: string; self: boolean; at: number }

export const ui = {
  wheelOpen: signal(false),
  wheelSel: signal<EmoteKind | null>(null),
  chatOpen: signal(false),
  chatLines: signal<ChatLine[]>([]),
  stamina: signal(1),
  locked: signal(false),
  inGame: signal(false),
  spectating: signal<{ on: boolean; target: string | null }>({ on: false, target: null }),
  /** v1.2 stance HUD: set only when it changes (mode null = hidden) */
  stance: signal<StanceView>({ mode: null, radiusM: 0, tag: null, soles: false }),
  /** v1.2: +1 per local footstep (the stance HUD pulses) */
  stepPulse: signal(0),
  /** v1.2 one-time stealth hint on screen */
  hint: signal<{ id: string; text: string; until: number } | null>(null),
  /** v1.2 crawl vents: you are in a duct until performance.now() reaches `until` (null = not crawling) */
  crawl: signal<{ until: number; total: number } | null>(null),
};

interface Marker { mesh: THREE.Group; until: number; born: number; mat: THREE.MeshBasicNodeMaterial; ring: THREE.MeshBasicNodeMaterial }

export function createPingMarkers(scene: THREE.Scene) {
  const markers: Marker[] = [];
  const diamond = new THREE.OctahedronGeometry(0.11, 0);
  const ringG = new THREE.RingGeometry(0.16, 0.2, 32);
  return {
    spawn(p: V3, color: string, ms: number) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(4), transparent: true, depthTest: false, depthWrite: false, fog: false });
      const ring = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(2.5), transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const d = new THREE.Mesh(diamond, mat);
      d.scale.set(1, 1.6, 1);
      d.position.y = 0.32;
      const r = new THREE.Mesh(ringG, ring);
      r.rotation.x = -Math.PI / 2;
      r.position.y = 0.02;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.3, 6), mat);
      stem.position.y = 0.15;
      g.add(d, r, stem);
      g.position.set(p[0], p[1], p[2]);
      g.renderOrder = 20;
      for (const c of g.children) c.renderOrder = 20;
      scene.add(g);
      const now = performance.now();
      markers.push({ mesh: g, until: now + ms, born: now, mat, ring });
    },
    update() {
      const now = performance.now();
      for (let i = markers.length - 1; i >= 0; i--) {
        const m = markers[i];
        const t = (now - m.born) / 1000;
        const left = (m.until - now) / 1000;
        const a = Math.max(0, Math.min(1, left / 0.6)) * Math.min(1, t / 0.12);
        m.mat.opacity = a;
        m.ring.opacity = a * (0.6 + 0.4 * Math.sin(t * 9));
        m.mesh.children[0].rotation.y = t * 2.4;
        const s = 1 + Math.sin(t * 6) * 0.08;
        m.mesh.children[1].scale.setScalar(s + (t % 1) * 0.6);
        if (now > m.until) {
          scene.remove(m.mesh);
          m.mat.dispose();
          m.ring.dispose();
          markers.splice(i, 1);
        }
      }
    },
    count: () => markers.length,
  };
}

let chatId = 1;
export function pushChat(ctx: ClientContext, name: string, text: string, self: boolean): void {
  const ms = Number((ctx.balance.players as Record<string, unknown> | undefined)?.chatShowMs ?? 9000);
  const line: ChatLine = { id: chatId++, name, text, self, at: performance.now() };
  ui.chatLines.value = [...ui.chatLines.value.slice(-5), line];
  setTimeout(() => {
    ui.chatLines.value = ui.chatLines.value.filter((l) => l !== line);
  }, ms);
}

/** wheel direction from an accumulated mouse vector (screen: +x right, +y down) */
export function wheelPick(x: number, y: number): EmoteKind | null {
  if (Math.hypot(x, y) < 24) return null;
  if (Math.abs(y) >= Math.abs(x)) return y < 0 ? WHEEL[0] : WHEEL[2];
  return x > 0 ? WHEEL[1] : WHEEL[3];
}
