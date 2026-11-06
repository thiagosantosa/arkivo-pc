// Pastas liberadas: "Unidades deste PC" (contrato §10.13 [2026-11-06]). A enumeração é do `fs-volume`; aqui ficam a
// visão da tela (o que já está liberado em cada unidade) e o caminho que o processo principal monta a partir do `id`
// que o renderer manda (o renderer nunca escolhe um caminho).
import { isAbsPathInside, type FsPlatform } from '@arkivo/shared';
import type { FsDriveUiView } from './agent-state';
import { driveRootLabel, type SharedRoot } from './fs-roots';
import { driveKindLabel, type DriveEntry } from './fs-volume';

export interface DriveViewContext {
  platform: FsPlatform;
  /** `%SystemDrive%` (`"C:"`). */
  systemDrive?: string;
  /** `realpath` da raiz de cada unidade (`subst` e rede mapeada apontam para outro lugar); ausente = a própria raiz. */
  reals?: ReadonlyMap<string, string>;
}

/** Marca, em cada unidade, a raiz que é ela inteira e quantas pastas liberadas ficam nela. */
export function buildDriveViews(entries: readonly DriveEntry[], roots: readonly SharedRoot[], c: DriveViewContext): FsDriveUiView[] {
  const sys = (c.systemDrive ?? 'C:').replace(/[:\\/]+$/, '').toUpperCase();
  return entries.map((d) => {
    const real = c.reals?.get(d.id) ?? d.root;
    const same = (r: SharedRoot) => isAbsPathInside(r.absPath, real, c.platform) && isAbsPathInside(real, r.absPath, c.platform);
    const whole = roots.find(same) ?? null;
    const inside = roots.filter((r) => !same(r) && isAbsPathInside(real, r.absPath, c.platform)).length;
    return {
      id: d.id,
      name: d.name,
      path: d.root,
      label: driveRootLabel(d, c.platform),
      volumeLabel: d.volumeLabel,
      kind: d.kind,
      kindLabel: driveKindLabel(d.kind),
      freeBytes: d.freeBytes,
      totalBytes: d.totalBytes,
      trashAvailable: d.trashAvailable,
      system: c.platform === 'windows' && d.id.toUpperCase() === sys,
      canAddWhole: c.platform === 'windows',
      wholeRootId: whole?.id ?? null,
      rootsInside: inside,
    };
  });
}

/**
 * `id` vindo do renderer → a unidade da lista atual, ou `null`. Só aceita o que a enumeração devolveu: o caminho
 * (`C:\`, `/Volumes/HD`) é sempre o da enumeração, nunca o texto recebido.
 */
export function findDrive(entries: readonly DriveEntry[], id: unknown): DriveEntry | null {
  if (typeof id !== 'string' || !id || id.length > 512) return null;
  return entries.find((d) => d.id === id) ?? null;
}
