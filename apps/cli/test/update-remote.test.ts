// apps/cli/test/update-remote.test.ts
//
// `archivist update` runs `npm install` and a build against whatever it pulls,
// so the remote comparison is not cosmetic: it is the control that stops the
// command executing code from somebody else's fork. It previously lived in the
// part of update.ts described as "thin plumbing ... not unit-tested directly",
// which was tenable while the value never changed. Renaming the repository
// changed it, so it is pinned here.
import { describe, expect, it } from 'vitest';
import { EXPECTED_REMOTE, isAcceptedRemote, normalizeRemoteUrl } from '../src/commands/update.js';

describe('normalizeRemoteUrl', () => {
  it('reduces every spelling git accepts to the same identity', () => {
    const forms = [
      'https://github.com/mahmouddattiaa/Genesys-Archivist.git',
      'https://github.com/mahmouddattiaa/Genesys-Archivist',
      'git@github.com:mahmouddattiaa/Genesys-Archivist.git',
      'ssh://git@github.com/mahmouddattiaa/Genesys-Archivist.git',
      'https://token@github.com/mahmouddattiaa/Genesys-Archivist.git',
    ];
    for (const form of forms) {
      expect(normalizeRemoteUrl(form), form).toBe(EXPECTED_REMOTE);
    }
  });

  it('is case-insensitive, because the repository name is capitalised', () => {
    // The rename introduced capitals ("Genesys-Archivist"). A comparison that
    // respected case would have refused every correctly configured clone.
    expect(normalizeRemoteUrl('https://GitHub.com/MahmoudDattiaa/Genesys-Archivist')).toBe(
      EXPECTED_REMOTE,
    );
  });
});

describe('isAcceptedRemote', () => {
  it('accepts the repository under its current name', () => {
    expect(isAcceptedRemote('https://github.com/mahmouddattiaa/Genesys-Archivist.git')).toBe(true);
  });

  it('still accepts the pre-rename name, which GitHub redirects to the same repository', () => {
    // Existing clones carry the old path. It resolves to this same repository,
    // so refusing it would strand them with no way to update.
    expect(
      isAcceptedRemote('https://github.com/mahmouddattiaa/genesys-architect-docs-mcp.git'),
    ).toBe(true);
  });

  it('refuses a fork, which is the whole point of the check', () => {
    expect(isAcceptedRemote('https://github.com/someone-else/Genesys-Archivist.git')).toBe(false);
  });

  it('refuses a lookalike host', () => {
    expect(
      isAcceptedRemote('https://github.com.evil.example/mahmouddattiaa/Genesys-Archivist'),
    ).toBe(false);
  });

  it('refuses a path that merely contains the expected one', () => {
    expect(isAcceptedRemote('https://github.com/attacker/mahmouddattiaa/Genesys-Archivist')).toBe(
      false,
    );
  });
});
