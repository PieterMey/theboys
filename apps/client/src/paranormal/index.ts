// Owner: env-paranormal (v1.2) client.
import type { ClientContext } from '../core/context.ts';

export interface ParanormalSettings { mode: 'full' | 'subtle' }
export interface ParanormalClientService { settings(): ParanormalSettings; setSettings(p: Partial<ParanormalSettings>): void }
declare module '../core/services.ts' {
  interface ServiceMap { paranormal: ParanormalClientService }
}
export function install(_ctx: ClientContext): void {}
