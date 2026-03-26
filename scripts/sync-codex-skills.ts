import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

type SkillSource = {
  label: string;
  root: string;
};

type Manifest = {
  installedAt: string;
  installedSkills: string[];
};

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const defaultTargetDir = path.join(homedir(), '.codex', 'skills');
const manifestName = '.nanoclaw-installed.json';

function parseArgs(argv: string[]): { targetDir: string } {
  let targetDir = defaultTargetDir;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --target');
      }
      targetDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { targetDir };
}

function printUsage(): void {
  console.log(`Usage: npm run skills:codex -- [--target <dir>]

Installs NanoClaw skill directories into the Codex skills directory.
Defaults to ${defaultTargetDir}`);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findSkillDirs(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const skillDirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(root, entry.name);
    if (await pathExists(path.join(skillDir, 'SKILL.md'))) {
      skillDirs.push(skillDir);
    }
  }

  return skillDirs.sort((left, right) => left.localeCompare(right));
}

async function loadManifest(manifestPath: string): Promise<Manifest | null> {
  if (!(await pathExists(manifestPath))) {
    return null;
  }

  try {
    const raw = await readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

async function copySkillDir(sourceDir: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
}

async function main(): Promise<void> {
  const { targetDir } = parseArgs(process.argv.slice(2));
  const sources: SkillSource[] = [
    {
      label: '.claude/skills',
      root: path.join(repoRoot, '.claude', 'skills'),
    },
    {
      label: 'container/skills',
      root: path.join(repoRoot, 'container', 'skills'),
    },
  ];

  await mkdir(targetDir, { recursive: true });

  const manifestPath = path.join(targetDir, manifestName);
  const previousManifest = await loadManifest(manifestPath);
  const installedSkills = new Set<string>();
  const copiedFrom: Array<{ name: string; source: string }> = [];

  for (const source of sources) {
    const skillDirs = await findSkillDirs(source.root);
    for (const skillDir of skillDirs) {
      const skillName = path.basename(skillDir);
      const targetSkillDir = path.join(targetDir, skillName);

      await copySkillDir(skillDir, targetSkillDir);
      installedSkills.add(skillName);
      copiedFrom.push({ name: skillName, source: source.label });
    }
  }

  if (previousManifest) {
    for (const previousSkill of previousManifest.installedSkills) {
      if (installedSkills.has(previousSkill)) {
        continue;
      }
      await rm(path.join(targetDir, previousSkill), {
        recursive: true,
        force: true,
      });
    }
  }

  const nextManifest: Manifest = {
    installedAt: new Date().toISOString(),
    installedSkills: [...installedSkills].sort((left, right) =>
      left.localeCompare(right),
    ),
  };

  await writeFile(
    manifestPath,
    `${JSON.stringify(nextManifest, null, 2)}\n`,
    'utf8',
  );

  const sortedCopies = copiedFrom.sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  console.log(`Installed ${sortedCopies.length} NanoClaw skills into ${targetDir}`);
  for (const copy of sortedCopies) {
    console.log(`- ${copy.name} <= ${copy.source}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
