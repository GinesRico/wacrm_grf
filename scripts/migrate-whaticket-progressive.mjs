#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const DEFAULTS = {
  prodWorkDir: '/home/docker/whaticket/prod',
  sourceDbContainer: 'whaticket_db_prod',
  sourceDbUser: 'avera',
  sourceDbName: 'whaticket_prod',
  sourceDumpInContainer: '/tmp/whaticket_backup.dump',
  dumpHostPath: '/home/docker/whaticket/backup/whaticket_backup.dump',
  sourcePublicDir: '/home/docker/whaticket/prod/data/backend/public',
  snapshotPublicDir: '/home/docker/whaticket/backup/export_snapshot/public',
  bridgeContainer: 'ppt6w0ho4yywicm0yon1tt4d',
  bridgeDbName: 'whaticket_import_tmp',
  bridgeDbUser: 'postgres',
  bridgeDbHost: 'ppt6w0ho4yywicm0yon1tt4d',
  bridgeDbPort: '5432',
  bridgeDbPass: '',
  bridgeDumpInContainer: '/tmp/whaticket_backup.dump',
  exportDir: '/tmp/whaticket-export',
  accountId: '4441e304-18b7-487f-98c3-57a101728091',
  mediaMode: 'alarik',
};

function q(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function envPrefix(env) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${q(value)}`)
    .join(' ');
}

async function prompt(rl, label, defaultValue, { secret = false } = {}) {
  const suffix = defaultValue ? ` [${secret ? '***' : defaultValue}]` : '';
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue || '';
}

async function confirm(rl, label, defaultYes = true) {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return ['y', 'yes', 's', 'si'].includes(answer);
}

function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${command}\n`);
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, ...(options.env ?? {}) },
      cwd: options.cwd ?? process.cwd(),
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}: ${command}`));
    });
    child.on('error', reject);
  });
}

async function maybeRun(rl, title, command, options = {}) {
  console.log(`\n=== ${title} ===`);
  if (!(await confirm(rl, 'Ejecutar este paso?', options.defaultYes ?? true))) {
    console.log('Saltado.');
    return false;
  }
  await run(command, options);
  return true;
}

async function collectConfig(rl) {
  console.log('\nMigracion progresiva WhaTicket -> WACRM');
  console.log('Perfil ARVERA precargado. Edita solo si ha cambiado el entorno.\n');

  const config = {
    ...DEFAULTS,
    bridgeDbPass: process.env.WHATICKET_DB_PASS || DEFAULTS.bridgeDbPass,
  };

  const editConfig = await confirm(rl, 'Editar rutas, contenedores o cuenta destino?', false);
  if (!editConfig) {
    if (!config.bridgeDbPass) {
      config.bridgeDbPass = await prompt(rl, 'Password BD puente', '', { secret: true });
    }
    config.sourceDumpInContainer = DEFAULTS.sourceDumpInContainer;
    config.bridgeDumpInContainer = DEFAULTS.bridgeDumpInContainer;
    return config;
  }

  config.prodWorkDir = await prompt(rl, 'Directorio host de WhaTicket produccion', DEFAULTS.prodWorkDir);
  config.sourceDbContainer = await prompt(rl, 'Contenedor PostgreSQL de WhaTicket produccion', DEFAULTS.sourceDbContainer);
  config.sourceDbUser = await prompt(rl, 'Usuario BD WhaTicket produccion', DEFAULTS.sourceDbUser);
  config.sourceDbName = await prompt(rl, 'Base BD WhaTicket produccion', DEFAULTS.sourceDbName);
  config.dumpHostPath = await prompt(rl, 'Ruta host donde guardar/copiar el dump', DEFAULTS.dumpHostPath);
  config.sourcePublicDir = await prompt(rl, 'Ruta public original de WhaTicket', DEFAULTS.sourcePublicDir);
  config.snapshotPublicDir = await prompt(rl, 'Ruta snapshot public/resync', DEFAULTS.snapshotPublicDir);

  config.bridgeContainer = await prompt(rl, 'Contenedor PostgreSQL puente', DEFAULTS.bridgeContainer);
  config.bridgeDbName = await prompt(rl, 'Base puente', DEFAULTS.bridgeDbName);
  config.bridgeDbUser = await prompt(rl, 'Usuario BD puente', DEFAULTS.bridgeDbUser);
  config.bridgeDbHost = await prompt(rl, 'Host interno BD puente para WACRM', DEFAULTS.bridgeDbHost);
  config.bridgeDbPort = await prompt(rl, 'Puerto BD puente', DEFAULTS.bridgeDbPort);
  config.bridgeDbPass = await prompt(rl, 'Password BD puente', config.bridgeDbPass, { secret: true });
  config.exportDir = await prompt(rl, 'Directorio paquete exportado JSON+media', DEFAULTS.exportDir);

  config.accountId = await prompt(rl, 'UUID cuenta WACRM destino', DEFAULTS.accountId);
  config.mediaMode = await prompt(rl, 'Modo media para import final (alarik/public/skip)', DEFAULTS.mediaMode);

  config.sourceDumpInContainer = DEFAULTS.sourceDumpInContainer;
  config.bridgeDumpInContainer = DEFAULTS.bridgeDumpInContainer;
  return config;
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const config = await collectConfig(rl);

    console.log('\nResumen:');
    console.table({
      prodWorkDir: config.prodWorkDir,
      sourceDbContainer: config.sourceDbContainer,
      sourceDb: `${config.sourceDbUser}@${config.sourceDbName}`,
      dumpHostPath: config.dumpHostPath,
      snapshotPublicDir: config.snapshotPublicDir,
      bridge: `${config.bridgeDbUser}@${config.bridgeDbHost}:${config.bridgeDbPort}/${config.bridgeDbName}`,
      exportDir: config.exportDir,
      accountId: config.accountId,
      mediaMode: config.mediaMode,
    });

    if (!(await confirm(rl, 'Continuar con esta configuracion?', true))) return;

    await maybeRun(
      rl,
      '1. Crear dump custom de WhaTicket produccion dentro del contenedor',
      `docker exec -t ${q(config.sourceDbContainer)} pg_dump -U ${q(config.sourceDbUser)} -d ${q(config.sourceDbName)} -Fc -f ${q(config.sourceDumpInContainer)}`
    );

    await maybeRun(
      rl,
      '2. Copiar dump desde contenedor produccion al host',
      `mkdir -p ${q(path.dirname(config.dumpHostPath))} && docker cp ${q(`${config.sourceDbContainer}:${config.sourceDumpInContainer}`)} ${q(config.dumpHostPath)}`
    );

    await maybeRun(
      rl,
      '3. Resync/copia de adjuntos public a snapshot',
      `mkdir -p ${q(config.snapshotPublicDir)} && rsync -a --ignore-missing-args ${q(`${config.sourcePublicDir.replace(/\/$/, '')}/`)} ${q(`${config.snapshotPublicDir.replace(/\/$/, '')}/`)}`
    );

    await maybeRun(
      rl,
      '4. Copiar dump host al contenedor PostgreSQL puente',
      `docker cp ${q(config.dumpHostPath)} ${q(`${config.bridgeContainer}:${config.bridgeDumpInContainer}`)}`
    );

    if (
      await confirm(
        rl,
        `5. Recrear la base puente ${config.bridgeDbName}? Esto borra su contenido actual`,
        false
      )
    ) {
      await run(
        `docker exec -t ${q(config.bridgeContainer)} dropdb --if-exists -U ${q(config.bridgeDbUser)} ${q(config.bridgeDbName)} && ` +
          `docker exec -t ${q(config.bridgeContainer)} createdb -U ${q(config.bridgeDbUser)} ${q(config.bridgeDbName)}`
      );
    } else {
      await maybeRun(
        rl,
        '5. Crear base puente si no existe',
        `docker exec -t ${q(config.bridgeContainer)} createdb -U ${q(config.bridgeDbUser)} ${q(config.bridgeDbName)}`,
        { defaultYes: false }
      );
    }

    await maybeRun(
      rl,
      '6. Restaurar dump en base puente',
      `docker exec -t ${q(config.bridgeContainer)} pg_restore --no-owner --role=${q(config.bridgeDbUser)} -U ${q(config.bridgeDbUser)} -d ${q(config.bridgeDbName)} ${q(config.bridgeDumpInContainer)}`
    );

    await maybeRun(
      rl,
      '7. Verificar tablas y conteos principales en base puente',
      `docker exec -t ${q(config.bridgeContainer)} psql -U ${q(config.bridgeDbUser)} -d ${q(config.bridgeDbName)} -c '\\dt' -c 'select count(*) as tickets from "Tickets"; select count(*) as messages from "Messages"; select count(*) as contacts from "Contacts"; select count(*) as quick_answers from "QuickAnswers"; select count(*) as ticket_status_events from "TicketStatusEvents";'`
    );

    await maybeRun(
      rl,
      '8. Exportar desde base puente a paquete JSON+media',
      `${envPrefix({
        WHATICKET_DB_HOST: config.bridgeDbHost,
        WHATICKET_DB_PORT: config.bridgeDbPort,
        WHATICKET_DB_NAME: config.bridgeDbName,
        WHATICKET_DB_USER: config.bridgeDbUser,
        WHATICKET_DB_PASS: config.bridgeDbPass,
      })} pnpm export:whaticket-db --out=${q(config.exportDir)} --public=${q(config.snapshotPublicDir)}`
    );

    await maybeRun(rl, '9. Aplicar migraciones WACRM', 'pnpm db:migrate');

    if (
      await confirm(
        rl,
        '10. Ejecutar import REAL en WACRM?',
        false
      )
    ) {
      await run(
        `pnpm import:whaticket ${q(config.exportDir)} --account=${q(config.accountId)} --media=${q(config.mediaMode)}`
      );
    }

    console.log('\nProceso terminado.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
