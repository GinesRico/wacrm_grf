#!/usr/bin/env node
import pg from 'pg';

const { Pool } = pg;

const DEFAULT_ACCOUNT_ID = '4441e304-18b7-487f-98c3-57a101728091';

function parseArgs(argv) {
  const args = {
    account: DEFAULT_ACCOUNT_ID,
    apply: false,
  };
  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.length ? rest.join('=') : true;
    }
  }
  return args;
}

function qIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function hasUsefulName(contact) {
  const name = String(contact.name ?? '').trim();
  if (!name) return false;
  return normalizedDigits(name) !== normalizedDigits(contact.phone);
}

function scoreContact(contact) {
  return (
    (hasUsefulName(contact) ? 1000 : 0) +
    (contact.avatar_url ? 200 : 0) +
    (contact.email ? 100 : 0) +
    (contact.company ? 50 : 0) +
    Number(contact.conversation_count ?? 0)
  );
}

function pickCanonical(contacts) {
  return [...contacts].sort((a, b) => {
    const scoreDiff = scoreContact(b) - scoreContact(a);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  })[0];
}

function bestField(canonical, duplicates, field) {
  if (canonical[field]) return canonical[field];
  return duplicates.find((contact) => contact[field])?.[field] ?? null;
}

function bestName(canonical, duplicates) {
  if (hasUsefulName(canonical)) return canonical.name;
  const better = duplicates.find(hasUsefulName);
  return better?.name ?? canonical.name;
}

function bestPhoneNormalized(canonical, duplicates) {
  return (
    normalizedDigits(canonical.phone) ||
    normalizedDigits(canonical.phone_normalized) ||
    duplicates
      .map((contact) => normalizedDigits(contact.phone) || normalizedDigits(contact.phone_normalized))
      .find(Boolean) ||
    null
  );
}

async function referencingContactColumns(client) {
  const { rows } = await client.query(`
    select kcu.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
      and ccu.table_schema = 'public'
      and ccu.table_name = 'contacts'
      and ccu.column_name = 'id'
    order by kcu.table_name, kcu.column_name
  `);
  return rows;
}

async function duplicateGroups(client, accountId) {
  const { rows } = await client.query(
    `
    with contact_keys as (
      select
        c.*,
        coalesce(
          nullif(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), ''),
          nullif(regexp_replace(coalesce(c.phone_normalized, ''), '\\D', '', 'g'), '')
        ) as phone_key
      from contacts c
      where c.account_id = $1
    )
    select
      c.*,
      c.phone_key,
      (
        select count(*)::int
        from conversations conv
        where conv.contact_id = c.id
      ) as conversation_count
    from contact_keys c
    where c.phone_key is not null
      and c.phone_key <> ''
      and c.phone_key in (
        select phone_key
        from contact_keys
        where phone_key is not null
          and phone_key <> ''
        group by phone_key
        having count(*) > 1
      )
    order by c.phone_key, c.created_at
    `,
    [accountId]
  );

  const groups = new Map();
  for (const row of rows) {
    const list = groups.get(row.phone_key) ?? [];
    list.push(row);
    groups.set(row.phone_key, list);
  }
  return groups;
}

async function mergeContact(client, accountId, canonical, duplicates, references) {
  const canonicalId = canonical.id;
  const duplicateIds = duplicates.map((contact) => contact.id);
  if (duplicateIds.length === 0) return { merged: 0, updatedRefs: 0 };

  await client.query(
    `
    update contacts
       set name = $2,
           email = $3,
           company = $4,
           avatar_url = $5,
           updated_at = now()
     where id = $1
    `,
    [
      canonicalId,
      bestName(canonical, duplicates),
      bestField(canonical, duplicates, 'email'),
      bestField(canonical, duplicates, 'company'),
      bestField(canonical, duplicates, 'avatar_url'),
    ]
  );

  await client.query(
    `
    delete from contact_tags d
    using contact_tags k
    where d.contact_id = any($1::uuid[])
      and k.contact_id = $2
      and k.tag_id = d.tag_id
    `,
    [duplicateIds, canonicalId]
  );

  await client.query(
    `
    delete from contact_custom_values d
    using contact_custom_values k
    where d.contact_id = any($1::uuid[])
      and k.contact_id = $2
      and k.custom_field_id = d.custom_field_id
    `,
    [duplicateIds, canonicalId]
  );

  let updatedRefs = 0;
  for (const ref of references) {
    const table = qIdent(ref.table_name);
    const column = qIdent(ref.column_name);
    const result = await client.query(
      `update ${table} set ${column} = $1 where ${column} = any($2::uuid[])`,
      [canonicalId, duplicateIds]
    );
    updatedRefs += result.rowCount ?? 0;
  }

  await client.query(
    `
    update whaticket_legacy_map
       set new_id = $3,
           updated_at = now()
     where account_id = $1
       and entity_type = 'contact'
       and new_id = any($2::text[])
    `,
    [accountId, duplicateIds, canonicalId]
  );

  await client.query('delete from contacts where id = any($1::uuid[])', [
    duplicateIds,
  ]);

  await client.query(
    `
    update contacts
       set phone_normalized = $2,
           updated_at = now()
     where id = $1
       and (phone_normalized is distinct from $2)
    `,
    [canonicalId, bestPhoneNormalized(canonical, duplicates)]
  );

  return { merged: duplicateIds.length, updatedRefs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const summary = {
    duplicateGroups: 0,
    duplicateContacts: 0,
    mergedContacts: 0,
    updatedReferences: 0,
    dryRun: !args.apply,
  };

  try {
    await client.query('begin');
    const references = await referencingContactColumns(client);
    const groups = await duplicateGroups(client, args.account);
    summary.duplicateGroups = groups.size;

    const examples = [];
    for (const [phoneKey, contacts] of groups) {
      const canonical = pickCanonical(contacts);
      const duplicates = contacts.filter((contact) => contact.id !== canonical.id);
      summary.duplicateContacts += duplicates.length;

      if (examples.length < 20) {
        examples.push({
          phone_key: phoneKey,
          keep_id: canonical.id,
          keep_name: canonical.name,
          duplicate_names: duplicates.map((contact) => contact.name).join(' | '),
          duplicate_count: duplicates.length,
        });
      }

      const result = await mergeContact(
        client,
        args.account,
        canonical,
        duplicates,
        references
      );
      summary.mergedContacts += result.merged;
      summary.updatedReferences += result.updatedRefs;
    }

    if (args.apply) {
      await client.query('commit');
    } else {
      await client.query('rollback');
    }

    console.log(JSON.stringify(summary, null, 2));
    if (examples.length) {
      console.table(examples);
    }
    if (!args.apply) {
      console.log('Dry-run only. Re-run with --apply to persist changes.');
    }
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
