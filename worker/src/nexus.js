/**
 * Nexus V2 GraphQL auto-discovery fetch — server-side port of the
 * pagination loop in assets/js/services.js fetchNexusTaggedMods, minus
 * the merge (that lives in merge.js) and the localStorage cache (KV plays
 * that role, in the B3 cron).
 *
 * The V2 API is technically unsupported (see docs/nexus-api-reference.md);
 * callers must treat failures as "keep last-known-good", never as "empty
 * dataset".
 */

export const NEXUS_GQL_ENDPOINT = 'https://api.nexusmods.com/v2/graphql';
export const NEXUS_GAME_ID = 3333; // Cyberpunk 2077
export const NEXUS_BATCH_SIZE = 50;

const QUERY = `
  query NCZoningMods($filter: ModsFilter!, $count: Int!, $offset: Int!) {
    mods(filter: $filter, count: $count, offset: $offset) {
      nodes {
        modId
        name
        summary
        description
        pictureUrl
        thumbnailUrl
        updatedAt
        uploader {
          name
        }
      }
      totalCount
    }
  }
`;

/**
 * Fetch every mod tagged NCZoning for CP2077. Throws on any page failure —
 * a partial node list must never be mistaken for the full tag population
 * (missing mods would be dropped from the map).
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @returns {Promise<Array>} raw GraphQL nodes
 */
export async function fetchTaggedModNodes(fetchImpl = fetch) {
  const nodes = [];
  let offset = 0;
  let totalCount = Infinity;

  while (offset < totalCount) {
    const res = await fetchImpl(NEXUS_GQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          filter: {
            gameId: [{ value: String(NEXUS_GAME_ID) }],
            tag: [{ value: 'NCZoning' }],
          },
          count: NEXUS_BATCH_SIZE,
          offset,
        },
      }),
    });
    if (!res.ok) throw new Error(`Nexus GraphQL HTTP ${res.status}`);

    const json = await res.json();
    const page = json?.data?.mods;
    if (!page) {
      throw new Error(
        `Nexus GraphQL: no mods page in response${json?.errors ? ` (${JSON.stringify(json.errors).slice(0, 200)})` : ''}`,
      );
    }

    totalCount = page.totalCount ?? 0;
    const pageNodes = page.nodes || [];
    if (pageNodes.length === 0) break;
    nodes.push(...pageNodes);
    offset += pageNodes.length;
    if (pageNodes.length < NEXUS_BATCH_SIZE) break; // last page
  }

  return nodes;
}
