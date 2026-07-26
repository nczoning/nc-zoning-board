/**
 * fix_coords_from_project.js
 *
 * ⚠️ HISTORICAL — THIS SCRIPT NO LONGER RUNS. Its board, user Project #3
 * (the Z/Yaw migration), was completed and deleted on 2026-07-26. `PROJECT_OWNER`
 * and `PROJECT_NUMBER` below therefore point at nothing, and the GraphQL query
 * will return `user.projectV2: null` rather than an obvious error.
 *
 * It was deliberately NOT repointed during the 2026-07-26 move of the NC Zoning
 * Board project to the `nczoning` org. That move concerns Project #1; this
 * script never referenced it. Swapping the owner here would aim a finished
 * one-off at a live board.
 *
 * Kept for the record of how the Z/Yaw backfill was done. To revive it for a
 * different board, note the query below uses `user(login:)` — an ORG-owned
 * project needs `organization(login:)` instead, which is a different root field,
 * not a string swap.
 *
 * Reads all "Incorrect Coords" items from the Z/Yaw migration GitHub Project,
 * overwrites X, Y (and optionally Z, Yaw) in data/locations/*.json, then marks
 * each item "Processed".
 *
 * Required project fields (Number):
 *   CET X         new CET X value
 *   CET Y         new CET Y value
 *   Z Coordinate  new Z value
 *   Yaw           new Yaw value
 * The processing loop skips any item with one of the four blank, so in
 * practice every field must be filled in per item.
 *
 * Usage:
 *   GITHUB_TOKEN=<projects_token> node scripts/fix_coords_from_project.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const GITHUB_GQL     = 'https://api.github.com/graphql';
const PROJECT_OWNER  = 'spuddeh';
const PROJECT_NUMBER = 3;
const LOCATIONS_DIR  = path.join(__dirname, '..', 'data', 'locations');

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is not set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

async function ghQuery(query, variables = {}) {
  const res = await fetch(GITHUB_GQL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

// ---------------------------------------------------------------------------
// Step 1: Get project meta, field IDs, and status option IDs
// ---------------------------------------------------------------------------

async function getProjectMeta() {
  const data = await ghQuery(`
    query($login: String!, $number: Int!) {
      user(login: $login) {
        projectV2(number: $number) {
          id title
          fields(first: 40) {
            nodes {
              ... on ProjectV2Field             { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }
    }
  `, { login: PROJECT_OWNER, number: PROJECT_NUMBER });

  const project = data.user.projectV2;
  console.log(`Project: "${project.title}" (${project.id})\n`);

  const fieldMap = {};
  for (const f of project.fields.nodes) fieldMap[f.name] = f;

  const statusField = fieldMap['Status'];
  if (!statusField?.options) {
    throw new Error('Status field not found or not a single-select field.');
  }

  const incorrectOption = statusField.options.find(o => o.name === 'Incorrect Coords');
  const processedOption = statusField.options.find(o => o.name === 'Processed');

  if (!incorrectOption) {
    throw new Error(
      'Status field has no "Incorrect Coords" option.\n' +
      `Add it at: https://github.com/users/${PROJECT_OWNER}/projects/${PROJECT_NUMBER}/settings`
    );
  }
  if (!processedOption) {
    throw new Error(
      'Status field has no "Processed" option.\n' +
      `Add it at: https://github.com/users/${PROJECT_OWNER}/projects/${PROJECT_NUMBER}/settings`
    );
  }

  if (!fieldMap['CET X']) {
    throw new Error(
      'Project is missing a "CET X" field.\n' +
      `Add a Number field named "CET X" at: https://github.com/users/${PROJECT_OWNER}/projects/${PROJECT_NUMBER}/settings`
    );
  }
  if (!fieldMap['CET Y']) {
    throw new Error(
      'Project is missing a "CET Y" field.\n' +
      `Add a Number field named "CET Y" at: https://github.com/users/${PROJECT_OWNER}/projects/${PROJECT_NUMBER}/settings`
    );
  }

  return { projectId: project.id, fieldMap, statusField, incorrectOption, processedOption };
}

// ---------------------------------------------------------------------------
// Step 2: Load all "Incorrect Coords" items from the project
// ---------------------------------------------------------------------------

async function loadIncorrectItems(projectId, fieldMap, incorrectOptionId) {
  const uuidFieldId   = fieldMap['UUID']?.id;
  const sourceFieldId = fieldMap['Source']?.id;
  const xFieldId      = fieldMap['CET X']?.id;
  const yFieldId      = fieldMap['CET Y']?.id;
  const zFieldId      = fieldMap['Z Coordinate']?.id;
  const yawFieldId    = fieldMap['Yaw']?.id;
  const statusFieldId = fieldMap['Status']?.id;

  const items = [];
  let cursor = null, hasNextPage = true;

  while (hasNextPage) {
    const data = await ghQuery(`
      query($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              nodes {
                id
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue {
                      text
                      field { ... on ProjectV2Field { id } }
                    }
                    ... on ProjectV2ItemFieldNumberValue {
                      number
                      field { ... on ProjectV2Field { id } }
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      optionId
                      field { ... on ProjectV2SingleSelectField { id } }
                    }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `, { projectId, cursor });

    const page = data.node.items;
    for (const item of page.nodes) {
      const fields = {};
      for (const fv of item.fieldValues.nodes) {
        const fieldId = fv.field?.id;
        if (!fieldId) continue;
        if (fv.text     !== undefined) fields[fieldId] = fv.text;
        if (fv.number   !== undefined) fields[fieldId] = fv.number;
        if (fv.optionId !== undefined) fields[fieldId] = fv.optionId;
      }

      if (fields[statusFieldId] !== incorrectOptionId) continue;

      items.push({
        itemId:  item.id,
        uuid:    fields[uuidFieldId]   ?? null,
        source:  fields[sourceFieldId] ?? null,
        x:       fields[xFieldId]      ?? null,
        y:       fields[yFieldId]      ?? null,
        z:       fields[zFieldId]      ?? null,
        yaw:     fields[yawFieldId]    ?? null,
      });
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor      = page.pageInfo.endCursor;
  }

  return items;
}

// ---------------------------------------------------------------------------
// Step 3: Set item status to Processed
// ---------------------------------------------------------------------------

async function setProcessed(projectId, itemId, statusFieldId, processedOptionId) {
  await ghQuery(`
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }
  `, {
    projectId,
    itemId,
    fieldId:  statusFieldId,
    optionId: processedOptionId,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== NC Zoning Board — Fix Coordinates from Project ===\n');

  const { projectId, fieldMap, statusField, incorrectOption, processedOption } = await getProjectMeta();

  console.log('Loading "Incorrect Coords" items from project...');
  const items = await loadIncorrectItems(projectId, fieldMap, incorrectOption.id);
  console.log(`Found ${items.length} item(s)\n`);

  if (items.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  let updated = 0, skipped = 0, failed = 0;

  for (const item of items) {
    const label = item.uuid || item.itemId;
    process.stdout.write(`${label} ... `);

    try {
      if (item.x === null || item.y === null || item.z === null || item.yaw === null) {
        const missing = ['x','y','z','yaw'].filter(k => item[k] === null).join(', ');
        console.log(`skip — missing fields: ${missing}`);
        skipped++;
        continue;
      }

      if (item.source === 'nexus-auto') {
        console.log('skip — nexus-auto (contact author to update their Nexus page)');
        skipped++;
        continue;
      }

      const filePath = path.join(LOCATIONS_DIR, `${item.uuid}.json`);
      if (!fs.existsSync(filePath)) {
        console.log(`skip — file not found: ${item.uuid}.json`);
        skipped++;
        continue;
      }

      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const oldCoords = existing.coordinates;

      // Always update X and Y. The missing-fields skip above guarantees z is
      // non-null here; the keep-existing fallback is defensive only.
      const newZ = item.z !== null ? item.z : (oldCoords[2] ?? null);
      existing.coordinates = newZ !== null
        ? [item.x, item.y, newZ]
        : [item.x, item.y];

      // The missing-fields skip above guarantees yaw is non-null here; the guard is defensive only.
      if (item.yaw !== null) {
        existing.yaw = item.yaw;
      }

      fs.writeFileSync(filePath, JSON.stringify(existing, null, 4) + '\n');
      await setProcessed(projectId, item.itemId, statusField.id, processedOption.id);

      const coordStr = existing.coordinates.join(', ');
      const yawStr   = item.yaw !== null ? `  yaw=${item.yaw}` : '';
      console.log(`✓  [${coordStr}]${yawStr}`);
      updated++;

    } catch (err) {
      console.log(`✗  ${err.message}`);
      failed++;
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Updated:  ${updated}`);
  console.log(`Skipped:  ${skipped}`);
  console.log(`Failed:   ${failed}`);

  if (updated > 0) {
    console.log('\nRun `node scripts/build_mods.js` to rebuild mods.json');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
