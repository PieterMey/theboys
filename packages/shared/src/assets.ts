// Owned by the assets track. Contract between the asset pipeline (tools/fetch-assets.mjs) and the client.
//
// The server serves .assets/dist at ASSET_BASE ('/assets/'). Every file except manifest.json, credits.json and basis/*
// has a content-hashed name, so it can be cached forever ('Cache-Control: public, max-age=31536000, immutable');
// manifest.json and credits.json must be 'no-cache'.
//
// Client usage:
//   await loadAssetManifest();                       // once at boot (fetches /assets/manifest.json)
//   const url = assetUrl('char.mannequin_m');        // '/assets/characters/mannequin_m.<hash>.glb' or null
//   const steps = assetVariants('sfx.step_concrete'); // ['sfx.step_concrete.1', ...] (present keys, sorted)
//   const t = textureKeys('concrete_floor');         // { albedo, normal, orm } keys (KTX2; WebP via assetUrl(k, 'webp'))
// A missing key returns null: fall back to placeholders (capsules / flat materials / procedural audio), never throw.
//
// Formats: GLB = meshopt (EXT_meshopt_compression + KHR_mesh_quantization) -> GLTFLoader.setMeshoptDecoder(MeshoptDecoder).
// Props embed KTX2 (KHR_texture_basisu) -> GLTFLoader.setKTX2Loader(new KTX2Loader().setTranscoderPath(basisPath()).detectSupport(renderer))
// after `await renderer.init()`. Surface textures are standalone .ktx2 (albedo sRGB; normal (OpenGL convention) + orm linear;
// orm = R ambient occlusion, G roughness, B metalness -> aoMap = roughnessMap = metalnessMap). Set RepeatWrapping yourself.
// Each texture entry also has a WebP alternative (alt.webp) for a no-KTX2 fallback path.
// Animation clips (anims/ual1.glb, anims/ual2.glb) contain only the skeleton + clips; bind them by bone name onto
// char.mannequin_m / char.mannequin_f (same 65-joint rig; scale tracks and non-root/pelvis translation tracks are already
// stripped, so they play on both bodies). Clip choices per ANIM id: the 'anim.clipmap' JSON (ClipMap below is its shape).
// Characters: per player use SkeletonUtils.clone(gltf.scene) + one AnimationMixer. The SkinnedMesh is an unnamed child of
// node 'Mannequin' (traverse for isSkinnedMesh); materials 'M_Main' (suit primary) and 'M_Joints' (suit secondary);
// attach items to bones 'hand_r' / 'hand_l' / 'Head'.
// mon.hound: Quaternius German Shepherd, already restyled at build time (saddlebag/straps removed, blind milky eyes,
// harness/bandana recoloured to fur); 11 clips incl. Idle_2 (head up, mouth open = alert), Run_Jump (lunge), Eating.
// Props are real-world metres (Poly Haven); props with moving parts keep their named nodes (fuse box door, camera).
// Loops (*_loop) are WAV for gapless looping; sfx.amb_drone.2 is 60 s (stream it via a media element, don't decode it).
// vo.pa_* are Company PA voice lines (ElevenLabs TTS). Dev-only viewer: /assets/_viewer.html?view=chars|hound|props|tex|audio.
// v1.2: font.reenie_beanie (TTF, SIL OFL 1.1, handwriting for lore pages: new FontFace('Reenie Beanie', 'url(' + assetUrl(k) + ')'))
// ships with its licence text font.reenie_beanie.license. Staged builds (fetch-assets --dist) are promoted additively.

export const ASSET_BASE = '/assets/';
export const ASSET_MANIFEST_URL = '/assets/manifest.json';

export type AssetGroup = 'boot' | 'lobby' | 'site';
/** v1.2: 'ttf' fonts (font.reenie_beanie, SIL OFL) and 'txt' licence texts (font.reenie_beanie.license) */
export type AssetType = 'glb' | 'ktx2' | 'webp' | 'ogg' | 'mp3' | 'wav' | 'json' | 'png' | 'ttf' | 'txt';

export interface AssetEntry {
  /** path relative to the manifest base, e.g. 'characters/mannequin_m.1a2b3c4d5e.glb' */
  url: string;
  bytes: number;
  /** load phase hint: boot = needed at join, lobby = van/parking lot, site = during a contract */
  group: AssetGroup;
  type: AssetType;
  /** alternative encodings of the same asset, e.g. { webp: 'tex/concrete_floor/albedo.<hash>.webp' } */
  alt?: Partial<Record<AssetType, string>>;
  /** textures: 'srgb' for albedo, 'linear' for normal / orm */
  colorSpace?: 'srgb' | 'linear';
  /** textures: source resolution class ('1k' | '2k') */
  res?: string;
  /** audio */
  durationSec?: number;
  loop?: boolean;
  /** upstream id, e.g. 'polyhaven:concrete_floor_worn_001' */
  source?: string;
}

export interface AssetManifest {
  v: 1;
  generated: string;
  /** URL prefix the files are served under ('/assets/') */
  base: string;
  /** KTX2 transcoder directory relative to base ('basis/') */
  basisPath?: string;
  totalBytes: number;
  groupBytes: Partial<Record<AssetGroup, number>>;
  files: Record<string, AssetEntry>;
}

/** Shape of the 'anim.clipmap' JSON. */
export interface ClipRef {
  /** manifest key of the GLB holding the clip ('anim.ual1' | 'anim.ual2' | 'mon.hound') */
  file: string;
  clip: string;
  loop: boolean;
  /** m/s the clip was authored for (from root motion); timeScale = moveSpeed / naturalSpeed */
  naturalSpeed?: number;
  timeScale?: number;
  clampWhenFinished?: boolean;
  /** true = closest available clip, not an exact match for the gesture */
  approx?: boolean;
  note?: string;
  alt?: ClipRef[];
}
export interface ClipMap {
  note: string;
  rig: { joints: number; hand_r: string; hand_l: string; head: string; spine: string; materials: { primary: string; secondary: string } };
  files: Record<string, string[]>;
  /** keys are ANIM names from anim.ts (idle, walk, ...); null = no clip (e.g. hidden) */
  players: Record<string, ClipRef | null | Record<string, ClipRef>>;
  listener: Record<string, ClipRef | string>;
  mannequin: Record<string, ClipRef | string>;
  hound: Record<string, ClipRef | string | Record<string, ClipRef>>;
  naturalSpeeds: Record<string, number>;
}

// <generated:keys>
// Written by tools/fetch-assets.mjs from the built manifest. Do not edit by hand.
export const ASSET_KEYS = [
  'anim.clipmap',
  'anim.ual1',
  'anim.ual2',
  'char.mannequin_f',
  'char.mannequin_m',
  'decal.atlas',
  'decal.index',
  'font.reenie_beanie',
  'font.reenie_beanie.license',
  'mon.hound',
  'prop.barrel',
  'prop.bed_frame',
  'prop.bottles',
  'prop.cabinet',
  'prop.cardboard_box',
  'prop.chair',
  'prop.chalkboard',
  'prop.crate',
  'prop.crowbar',
  'prop.desk',
  'prop.drawer_chest',
  'prop.flashlight',
  'prop.fluorescent_lamp',
  'prop.fuse_box',
  'prop.gas_mask',
  'prop.generator',
  'prop.jerrycan',
  'prop.medical_box',
  'prop.nightstand',
  'prop.ornate_mirror',
  'prop.picture_frame',
  'prop.radio',
  'prop.rat',
  'prop.security_camera',
  'prop.shelves',
  'prop.shutter_door',
  'prop.television',
  'prop.tool_chest',
  'prop.trash_can',
  'prop.wall_clock',
  'prop.wet_floor_sign',
  'prop.wheelchair',
  'prop.wooden_chair',
  'sfx.alarm_short',
  'sfx.amb_drone.1',
  'sfx.amb_drone.2',
  'sfx.amb_machine_loop',
  'sfx.body_fall.1',
  'sfx.bone_crack.1',
  'sfx.bone_crack.2',
  'sfx.bottle_smash.1',
  'sfx.bottle_smash.2',
  'sfx.breath_scared.1',
  'sfx.breath_scared.2',
  'sfx.breath_scared.3',
  'sfx.breath_scared.4',
  'sfx.cloth.1',
  'sfx.cloth.2',
  'sfx.core_hum_loop',
  'sfx.creature_breath.1',
  'sfx.creature_breath.2',
  'sfx.creature_death.1',
  'sfx.creature_growl.1',
  'sfx.creature_growl.2',
  'sfx.creature_growl.3',
  'sfx.creature_growl.4',
  'sfx.creature_scream.1',
  'sfx.creature_scream.2',
  'sfx.crowbar_hit.1',
  'sfx.crowbar_hit.2',
  'sfx.death_sting',
  'sfx.distant_door_slam',
  'sfx.door_close.1',
  'sfx.door_close.2',
  'sfx.door_creak.1',
  'sfx.door_creak.2',
  'sfx.door_creak.3',
  'sfx.door_open.1',
  'sfx.door_open.2',
  'sfx.drip.1',
  'sfx.drip.2',
  'sfx.drip.3',
  'sfx.drip.4',
  'sfx.facility_drone_loop',
  'sfx.flashlight_click',
  'sfx.fluorescent_hum_loop',
  'sfx.glass_break.1',
  'sfx.glass_break.2',
  'sfx.hound_alert_huff',
  'sfx.hound_charge_bark',
  'sfx.hound_eating',
  'sfx.hound_growl_low',
  'sfx.hound_sniff',
  'sfx.item_drop.1',
  'sfx.item_drop.2',
  'sfx.item_pickup.1',
  'sfx.item_pickup.2',
  'sfx.keypad_accept',
  'sfx.keypad_beep',
  'sfx.keypad_deny',
  'sfx.keypad_press.1',
  'sfx.keypad_press.2',
  'sfx.keypad_press.3',
  'sfx.lever_clunk_heavy',
  'sfx.listener_click_tick',
  'sfx.listener_radio_whisper.1',
  'sfx.listener_radio_whisper.2',
  'sfx.listener_radio_whisper.3',
  'sfx.listener_vent_crawl',
  'sfx.loot_deposit',
  'sfx.mannequin_creak',
  'sfx.mannequin_scrape',
  'sfx.metal_click',
  'sfx.metal_hit.1',
  'sfx.metal_hit.2',
  'sfx.metal_hit.3',
  'sfx.metal_hit.4',
  'sfx.metal_latch',
  'sfx.power_down_blackout',
  'sfx.power_up_surge',
  'sfx.radio_squelch_off',
  'sfx.radio_squelch_on',
  'sfx.radio_static_burst',
  'sfx.security_door_slam',
  'sfx.step_carpet.1',
  'sfx.step_carpet.2',
  'sfx.step_carpet.3',
  'sfx.step_concrete.1',
  'sfx.step_concrete.2',
  'sfx.step_concrete.3',
  'sfx.step_concrete.4',
  'sfx.step_metal.1',
  'sfx.step_metal.2',
  'sfx.step_metal.3',
  'sfx.step_metal.4',
  'sfx.step_wood.1',
  'sfx.step_wood.2',
  'sfx.step_wood.3',
  'sfx.step_wood.4',
  'sfx.switch_click.1',
  'sfx.switch_click.2',
  'sfx.ui_click',
  'sfx.ui_close',
  'sfx.ui_confirm',
  'sfx.ui_deny',
  'sfx.ui_hover',
  'sfx.ui_open',
  'sfx.van_engine_idle_loop',
  'sfx.van_horn',
  'sfx.vault_unlock_heavy',
  'sfx.wood_hit.1',
  'sfx.wood_hit.2',
  'tex.asphalt.albedo',
  'tex.asphalt.normal',
  'tex.asphalt.orm',
  'tex.asphalt_wet.albedo',
  'tex.asphalt_wet.normal',
  'tex.asphalt_wet.orm',
  'tex.brick.albedo',
  'tex.brick.normal',
  'tex.brick.orm',
  'tex.carpet.albedo',
  'tex.carpet.normal',
  'tex.carpet.orm',
  'tex.ceiling_plaster.albedo',
  'tex.ceiling_plaster.normal',
  'tex.ceiling_plaster.orm',
  'tex.ceiling_tiles.albedo',
  'tex.ceiling_tiles.normal',
  'tex.ceiling_tiles.orm',
  'tex.concrete_floor.albedo',
  'tex.concrete_floor.normal',
  'tex.concrete_floor.orm',
  'tex.corrugated_metal.albedo',
  'tex.corrugated_metal.normal',
  'tex.corrugated_metal.orm',
  'tex.floor_linoleum.albedo',
  'tex.floor_linoleum.normal',
  'tex.floor_linoleum.orm',
  'tex.floor_tiles.albedo',
  'tex.floor_tiles.normal',
  'tex.floor_tiles.orm',
  'tex.grating.albedo',
  'tex.grating.normal',
  'tex.grating.orm',
  'tex.insulated_panel.albedo',
  'tex.insulated_panel.normal',
  'tex.insulated_panel.orm',
  'tex.metal_painted.albedo',
  'tex.metal_painted.normal',
  'tex.metal_painted.orm',
  'tex.metal_plate.albedo',
  'tex.metal_plate.normal',
  'tex.metal_plate.orm',
  'tex.metal_rusty.albedo',
  'tex.metal_rusty.normal',
  'tex.metal_rusty.orm',
  'tex.parquet.albedo',
  'tex.parquet.normal',
  'tex.parquet.orm',
  'tex.rubber_floor.albedo',
  'tex.rubber_floor.normal',
  'tex.rubber_floor.orm',
  'tex.terrazzo.albedo',
  'tex.terrazzo.normal',
  'tex.terrazzo.orm',
  'tex.tiles_pool.albedo',
  'tex.tiles_pool.normal',
  'tex.tiles_pool.orm',
  'tex.tiles_subway.albedo',
  'tex.tiles_subway.normal',
  'tex.tiles_subway.orm',
  'tex.tiles_white.albedo',
  'tex.tiles_white.normal',
  'tex.tiles_white.orm',
  'tex.wall_concrete.albedo',
  'tex.wall_concrete.normal',
  'tex.wall_concrete.orm',
  'tex.wall_plaster.albedo',
  'tex.wall_plaster.normal',
  'tex.wall_plaster.orm',
  'tex.wallpaper.albedo',
  'tex.wallpaper.normal',
  'tex.wallpaper.orm',
  'tex.wood_panel.albedo',
  'tex.wood_panel.normal',
  'tex.wood_panel.orm',
  'vo.pa_blackout',
  'vo.pa_core_reminder',
  'vo.pa_departure_warning',
  'vo.pa_quota_reminder',
  'vo.pa_van_leaving',
  'vo.pa_welcome',
] as const;
export const MATERIAL_IDS = [
  'asphalt',
  'asphalt_wet',
  'brick',
  'carpet',
  'ceiling_plaster',
  'ceiling_tiles',
  'concrete_floor',
  'corrugated_metal',
  'floor_linoleum',
  'floor_tiles',
  'grating',
  'insulated_panel',
  'metal_painted',
  'metal_plate',
  'metal_rusty',
  'parquet',
  'rubber_floor',
  'terrazzo',
  'tiles_pool',
  'tiles_subway',
  'tiles_white',
  'wall_concrete',
  'wall_plaster',
  'wallpaper',
  'wood_panel',
] as const;
// </generated:keys>

export type AssetKey = (typeof ASSET_KEYS)[number];
export type MaterialId = (typeof MATERIAL_IDS)[number];
export const TEXTURE_MAPS = ['albedo', 'normal', 'orm'] as const;
export type TextureMap = (typeof TEXTURE_MAPS)[number];

let current: AssetManifest | null = null;

export function setAssetManifest(m: AssetManifest | null): void {
  current = m;
}

export function getAssetManifest(): AssetManifest | null {
  return current;
}

/** Fetches and installs the manifest. Resolves null (and keeps placeholders working) if it is missing. */
export async function loadAssetManifest(url: string = ASSET_MANIFEST_URL, fetchFn: typeof fetch = fetch): Promise<AssetManifest | null> {
  try {
    const res = await fetchFn(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const m = (await res.json()) as AssetManifest;
    if (!m || m.v !== 1 || !m.files) return null;
    current = m;
    return m;
  } catch {
    return null;
  }
}

function base(): string {
  const b = current?.base ?? ASSET_BASE;
  return b.endsWith('/') ? b : b + '/';
}

export function hasAsset(key: AssetKey | (string & {})): boolean {
  return !!current?.files[key];
}

export function assetEntry(key: AssetKey | (string & {})): AssetEntry | null {
  return current?.files[key] ?? null;
}

/** Absolute URL path for a key (optionally an alternative encoding such as 'webp'), or null if not available. */
export function assetUrl(key: AssetKey | (string & {}), alt?: AssetType): string | null {
  const e = current?.files[key];
  if (!e) return null;
  if (alt && alt !== e.type) {
    const a = e.alt?.[alt];
    return a ? base() + a : null;
  }
  return base() + e.url;
}

/** KTX2 transcoder directory for KTX2Loader.setTranscoderPath(). */
export function basisPath(): string {
  return base() + (current?.basisPath ?? 'basis/');
}

/** Present keys of a variant set: assetVariants('sfx.step_concrete') -> ['sfx.step_concrete.1', 'sfx.step_concrete.2', ...]. */
export function assetVariants(prefix: string): string[] {
  if (!current) return [];
  const p = prefix + '.';
  return Object.keys(current.files)
    .filter((k) => k.startsWith(p) && /^\d+$/.test(k.slice(p.length)))
    .sort((a, b) => Number(a.slice(p.length)) - Number(b.slice(p.length)));
}

/** All present keys with a prefix, e.g. assetKeysWithPrefix('prop.'). */
export function assetKeysWithPrefix(prefix: string): string[] {
  return current ? Object.keys(current.files).filter((k) => k.startsWith(prefix)).sort() : [];
}

export function assetKeysInGroup(group: AssetGroup): string[] {
  return current ? Object.keys(current.files).filter((k) => current!.files[k].group === group).sort() : [];
}

export function textureKeys(material: MaterialId | (string & {})): Record<TextureMap, string> {
  return { albedo: `tex.${material}.albedo`, normal: `tex.${material}.normal`, orm: `tex.${material}.orm` };
}
