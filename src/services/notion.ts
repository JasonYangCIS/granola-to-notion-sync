import { Client, APIErrorCode, isNotionClientError } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints.js";

const RATE_LIMIT_DELAY_MS = 340; // ~3 req/s
const MAX_RETRIES = 3;
const MAX_BLOCKS_PER_REQUEST = 100;

let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, RATE_LIMIT_DELAY_MS - elapsed)
    );
  }
  lastRequestTime = Date.now();
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await rateLimit();
      return await fn();
    } catch (err) {
      if (
        isNotionClientError(err) &&
        err.code === APIErrorCode.RateLimited
      ) {
        const waitMs = (attempt + 1) * 1000;
        console.warn(`  Rate limited, retrying in ${waitMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (
        isNotionClientError(err) &&
        err.code === APIErrorCode.InternalServerError &&
        attempt < MAX_RETRIES - 1
      ) {
        const waitMs = (attempt + 1) * 2000;
        console.warn(`  Server error, retrying in ${waitMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

export function createNotionClient(token: string): Client {
  return new Client({ auth: token });
}

export async function createPage(
  client: Client,
  parentPageId: string,
  title: string,
  emoji?: string
): Promise<string> {
  const response = await withRetry(() =>
    client.pages.create({
      parent: { page_id: parentPageId },
      icon: emoji ? { type: "emoji", emoji: emoji as any } : undefined,
      properties: {
        title: {
          title: [{ text: { content: title } }],
        },
      },
    })
  );

  return response.id;
}

/**
 * Create a Notion database (inline) under a parent page.
 * The database has "Name" (title) and "Date" (date) properties.
 */
export async function createDatabase(
  client: Client,
  parentPageId: string,
  title: string,
  emoji?: string
): Promise<string> {
  const response = await withRetry(() =>
    client.databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      icon: emoji ? { type: "emoji", emoji: emoji as any } : undefined,
      is_inline: true,
      properties: {
        Name: { title: {} },
        Date: { date: {} },
      },
    })
  );

  return response.id;
}

/**
 * Create a page inside a Notion database, with title and date properties.
 */
export async function createDatabaseEntry(
  client: Client,
  databaseId: string,
  title: string,
  date: string | null, // ISO date string (YYYY-MM-DD) or null
  emoji?: string
): Promise<string> {
  const properties: Record<string, any> = {
    Name: {
      title: [{ text: { content: title } }],
    },
  };

  if (date) {
    properties.Date = {
      date: { start: date },
    };
  }

  const response = await withRetry(() =>
    client.pages.create({
      parent: { database_id: databaseId },
      icon: emoji ? { type: "emoji", emoji: emoji as any } : undefined,
      properties,
    })
  );

  return response.id;
}

export async function appendBlocks(
  client: Client,
  pageId: string,
  blocks: BlockObjectRequest[]
): Promise<void> {
  // Chunk into batches of 100 (Notion API limit)
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    const chunk = blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST);
    await withRetry(() =>
      client.blocks.children.append({
        block_id: pageId,
        children: chunk,
      })
    );
  }
}

export async function archivePage(
  client: Client,
  pageId: string
): Promise<void> {
  await withRetry(() =>
    client.pages.update({
      page_id: pageId,
      archived: true,
    })
  );
}

export async function verifyPageAccess(
  client: Client,
  pageId: string
): Promise<void> {
  try {
    await withRetry(() => client.pages.retrieve({ page_id: pageId }));
  } catch (err) {
    if (isNotionClientError(err)) {
      if (err.code === APIErrorCode.ObjectNotFound) {
        console.error(
          `Error: Parent page not found (${pageId}).\n` +
            "Make sure the page exists and your integration has been added to it.\n" +
            'In Notion: page "..." menu → "Add connections" → select your integration.'
        );
        process.exit(1);
      }
      if (err.code === APIErrorCode.Unauthorized) {
        console.error(
          "Error: Invalid Notion token.\n" +
            "Check your NOTION_TOKEN in .env or create a new integration at\n" +
            "https://www.notion.so/my-integrations"
        );
        process.exit(1);
      }
    }
    throw err;
  }
}
