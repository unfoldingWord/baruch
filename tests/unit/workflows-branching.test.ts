import { describe, expect, it } from 'vitest';
import ciYml from '../../.github/workflows/ci.yml?raw';
import stagingYml from '../../.github/workflows/deploy-staging.yml?raw';
import devYml from '../../.github/workflows/deploy-dev.yml?raw';
import prodYml from '../../.github/workflows/deploy-prod.yml?raw';

/**
 * Branching model (develop = integration, main = release):
 * - CI runs for both branches, and refuses a PR into main unless it comes
 *   from develop or hotfix/*.
 * - Staging deploys only from develop, and never from a PR branch.
 * - Dev previews deploy for PRs into develop or main.
 * - Production deploys only from a v* release tag that is on main.
 */
describe('workflow triggers follow the develop/main branching model', () => {
  it('CI runs on push and pull_request for develop and main', () => {
    const onBlock = ciYml.slice(ciYml.indexOf('\non:'), ciYml.indexOf('\njobs:'));
    expect(onBlock).toMatch(/push:\s*\n\s*branches: \[main, develop\]/);
    expect(onBlock).toMatch(/pull_request:\s*\n\s*branches: \[main, develop\]/);
  });

  it('CI has a Release Source job that only allows develop or hotfix/* into main', () => {
    expect(ciYml).toContain('name: Release Source');
    expect(ciYml).toContain(
      "if: ${{ github.event_name == 'pull_request' && github.base_ref == 'main' }}"
    );
    expect(ciYml).toContain('develop|hotfix/*) echo "ok" ;;');
    // The branch name is PR-author controlled: it must reach the script via env.
    expect(ciYml).toContain('HEAD_REF: ${{ github.head_ref }}');
    expect(ciYml).not.toMatch(/run: \|[\s\S]*\$\{\{ github\.head_ref \}\}/);
  });

  it('staging deploys from develop only and has no pull_request trigger', () => {
    const onBlock = stagingYml.slice(stagingYml.indexOf('\non:'), stagingYml.indexOf('\njobs:'));
    expect(onBlock).not.toContain('pull_request');
    expect(onBlock).toMatch(/workflow_run:[\s\S]*branches: \[develop\]/);
  });

  it('staging deploys only after CI runs triggered by a push, not by a PR whose head is develop', () => {
    // A release PR (develop → main) runs CI with head branch develop, which the
    // workflow_run branch filter also matches; without this, every merge into
    // develop would deploy staging twice while a release PR is open.
    expect(stagingYml).toContain("github.event.workflow_run.event == 'push'");
    expect(stagingYml).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
  });

  it('dev previews deploy for PRs into develop or main', () => {
    const onBlock = devYml.slice(devYml.indexOf('\non:'), devYml.indexOf('\njobs:'));
    expect(onBlock).toMatch(/pull_request:\s*\n\s*branches: \[main, develop\]/);
  });

  it('production refuses to deploy anything but a v* tag on main, before any deploy step', () => {
    const guardAt = prodYml.indexOf('name: Require a release tag on main');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(prodYml.indexOf('wrangler-action'));
    expect(prodYml).toContain('refs/tags/v*)');
    expect(prodYml).toContain('git fetch --no-tags origin main');
    expect(prodYml).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(prodYml).toMatch(/fetch-depth: 0/);
    expect(prodYml).not.toContain("github.ref == 'refs/heads/main'");
  });
});
