// apps/cli/src/commands/doctor.ts
import type { ProfileMetadata } from '@genesys-archivist/security';

export interface DoctorDeps {
  readonly nodeVersion: string;
  readonly outputRoot: string;
  readonly outputRootWritable: boolean;
  readonly profiles: readonly ProfileMetadata[];
  readonly secretStoreAvailable: boolean;
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

const MIN_MAJOR = 22;

export function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const major = Number(/^v(\d+)\./.exec(deps.nodeVersion)?.[1] ?? '0');
  checks.push(
    major >= MIN_MAJOR
      ? {
          name: 'node-version',
          status: 'pass',
          detail: `Node ${String(major)} meets the minimum of ${String(MIN_MAJOR)}.`,
        }
      : {
          name: 'node-version',
          status: 'fail',
          detail: `Node ${String(major)} is below the required ${String(MIN_MAJOR)}.`,
        },
  );

  // The path is echoed back only as a boolean outcome. Output roots can embed
  // customer names, so the detail never interpolates deps.outputRoot.
  checks.push(
    deps.outputRootWritable
      ? { name: 'output-root', status: 'pass', detail: 'Output root exists and is writable.' }
      : { name: 'output-root', status: 'fail', detail: 'Output root is missing or not writable.' },
  );

  checks.push(
    deps.secretStoreAvailable
      ? { name: 'secret-store', status: 'pass', detail: 'Credential store is reachable.' }
      : {
          name: 'secret-store',
          status: 'fail',
          detail: 'Credential store is unavailable. Run: archivist profile add',
        },
  );

  checks.push(
    deps.profiles.length > 0
      ? {
          name: 'profiles',
          status: 'pass',
          detail: `${String(deps.profiles.length)} profile(s) configured.`,
        }
      : {
          name: 'profiles',
          status: 'warn',
          detail: 'No profile configured yet. Run: archivist profile add',
        },
  );

  return Promise.resolve({ checks, ok: !checks.some((c) => c.status === 'fail') });
}
