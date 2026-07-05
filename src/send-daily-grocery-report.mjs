import OpenAI from 'openai';
import { Resend } from 'resend';
import { chromium } from 'playwright';

const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const sourceFetchConcurrency = 3;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const targetStores = [
  "Smith's Food and Drug",
  "Macey's",
  "Lee's Marketplace",
  "Ridley's",
  'Costco',
  'Walmart Logan',
];

const targetStoreAliases = new Map([
  ['smiths', "Smith's Food and Drug"],
  ['smith s', "Smith's Food and Drug"],
  ['smiths food and drug', "Smith's Food and Drug"],
  ['smith s food and drug', "Smith's Food and Drug"],
  ['kroger', "Smith's Food and Drug"],
  ['maceys', "Macey's"],
  ['macey s', "Macey's"],
  ['lees', "Lee's Marketplace"],
  ['lee s', "Lee's Marketplace"],
  ['lees marketplace', "Lee's Marketplace"],
  ['lee s marketplace', "Lee's Marketplace"],
  ['ridleys', "Ridley's"],
  ['ridley s', "Ridley's"],
  ['costco', 'Costco'],
  ['walmart', 'Walmart Logan'],
  ['walmart logan', 'Walmart Logan'],
]);

const dealSources = [
  {
    storeName: "Smith's Weekly Ad",
    targetStore: "Smith's Food and Drug",
    url: 'https://www.smithsfoodanddrug.com/weeklyad',
  },
  {
    storeName: "Smith's Weekly Digital Deals",
    targetStore: "Smith's Food and Drug",
    url: 'https://www.smithsfoodanddrug.com/pr/weekly-digital-deals',
  },
  {
    storeName: "Macey's Weekly Ad",
    targetStore: "Macey's",
    url: 'https://shop.maceys.com/store/maceys/flyers/weekly',
  },
  {
    storeName: "Macey's Storefront Weekly Ad",
    targetStore: "Macey's",
    url: 'https://shop.maceys.com/store/maceys/storefront',
  },
  {
    storeName: "Lee's Marketplace Storefront",
    targetStore: "Lee's Marketplace",
    url: 'https://shop.leesmarketplace.com/store/lees-marketplace/storefront',
  },
  {
    storeName: "Lee's Marketplace Ad",
    targetStore: "Lee's Marketplace",
    url: 'https://ad.leesmarketplace.com/',
  },
  {
    storeName: "Ridley's RPerks Weekly Ad",
    targetStore: "Ridley's",
    url: 'https://rperks.shopridleys.com/interactive-weekly-ad',
  },
  {
    storeName: 'Costco Warehouse Savings',
    targetStore: 'Costco',
    url: 'https://www.costco.com/warehouse-savings.html',
  },
  {
    storeName: 'Walmart Logan',
    targetStore: 'Walmart Logan',
    url: 'https://www.walmart.com/store/1888-logan-ut',
  },
];

const searchInstructions = [
  'Smiths Food and Drug Logan Utah weekly ad digital deals chicken eggs produce household',
  'Maceys Logan Utah weekly ad chicken produce household',
  'Lees Marketplace Logan Utah weekly ad chicken produce household',
  'Ridleys Logan Utah RPerks weekly ad chicken produce household',
  'Costco Logan Utah warehouse savings grocery household',
  'Walmart Logan Utah grocery deals chicken eggs produce household',
];

function formatDateForReport() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function assertRequiredEnvironmentVariables() {
  const requiredEnvironmentVariables = [
    'OPENAI_API_KEY',
    'RESEND_API_KEY',
    'DEAL_REPORT_TO_EMAIL',
  ];

  const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
    (environmentVariableName) => !process.env[environmentVariableName]
  );

  if (missingEnvironmentVariables.length > 0) {
    throw new Error(
      `Missing environment variables: ${missingEnvironmentVariables.join(', ')}`
    );
  }
}

function looksLikeWeeklyAdText(text) {
  const normalizedText = text.toLowerCase();
  const hasPrices = /\$\d|save\s+\$|\d+\s*\/\s*\$\d|\bbuy\b.*\bget\b/i.test(text);
  const hasDealWords = [
    'weekly ad',
    'digital deal',
    'coupon',
    'sale',
    'save',
    'price',
    'lb',
  ].some((word) => normalizedText.includes(word));

  return hasPrices && hasDealWords;
}

function compactText(text, maxLength = 18000) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeStoreName(storeName) {
  return storeName
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveTargetStoreName(storeName) {
  const normalizedStoreName = normalizeStoreName(storeName);
  const aliasMatch = targetStoreAliases.get(normalizedStoreName);

  if (aliasMatch) {
    return aliasMatch;
  }

  return targetStores.find((targetStore) => {
    const normalizedTargetStore = normalizeStoreName(targetStore);
    return (
      normalizedStoreName === normalizedTargetStore ||
      normalizedStoreName.includes(normalizedTargetStore) ||
      normalizedTargetStore.includes(normalizedStoreName)
    );
  });
}

function extractJsonObject(text) {
  const trimmedText = text.trim();
  const fencedJsonMatch = trimmedText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fencedJsonMatch?.[1] ?? trimmedText;
  const startIndex = jsonText.indexOf('{');
  const endIndex = jsonText.lastIndexOf('}');

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error('The model did not return a JSON object.');
  }

  return JSON.parse(jsonText.slice(startIndex, endIndex + 1));
}

async function fetchDealSource(source, browser) {
  const page = await browser.newPage();
  const startedAt = Date.now();

  try {
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
    });

    await page.goto(source.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForTimeout(5000);

    for (let scrollIndex = 0; scrollIndex < 4; scrollIndex += 1) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(750);
    }

    const pageText = await page.locator('body').innerText({ timeout: 10000 });
    const metadata = await page.evaluate(() => {
      const metaDescription =
        document
          .querySelector('meta[name="description"], meta[property="og:description"]')
          ?.getAttribute('content') ?? '';
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((link) => `${link.textContent?.trim() ?? ''} ${link.href}`.trim())
        .filter(Boolean)
        .slice(0, 80);
      const images = Array.from(document.querySelectorAll('img'))
        .map((image) => image.alt || image.getAttribute('aria-label') || '')
        .filter(Boolean)
        .slice(0, 80);

      return { title: document.title, metaDescription, links, images };
    });

    const combinedText = compactText(
      [
        `Title: ${metadata.title}`,
        `Description: ${metadata.metaDescription}`,
        pageText,
        metadata.links.length > 0 ? `Links: ${metadata.links.join(' | ')}` : '',
        metadata.images.length > 0 ? `Image labels: ${metadata.images.join(' | ')}` : '',
      ].join('\n')
    );

    return {
      ...source,
      ok: true,
      status: 'loaded',
      characterCount: combinedText.length,
      elapsedMs: Date.now() - startedAt,
      realWeeklyAdContent: looksLikeWeeklyAdText(combinedText),
      text: combinedText,
    };
  } catch (error) {
    return {
      ...source,
      ok: false,
      status: 'load error',
      characterCount: 0,
      elapsedMs: Date.now() - startedAt,
      realWeeklyAdContent: false,
      text: '',
      error: error.message,
    };
  } finally {
    await page.close();
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

function buildSourceDiagnostics(sourceResults) {
  return sourceResults.map((sourceResult) => ({
    storeName: sourceResult.storeName,
    url: sourceResult.url,
    status: sourceResult.status,
    characterCount: sourceResult.characterCount,
    elapsedMs: sourceResult.elapsedMs,
    realWeeklyAdContent: sourceResult.realWeeklyAdContent,
    error: sourceResult.error,
    preview: sourceResult.text.slice(0, 1000),
  }));
}

async function createReportWithWebSearch(sourceResults) {
  const today = formatDateForReport();
  const sourceDiagnostics = buildSourceDiagnostics(sourceResults);

  return openai.responses.create({
    model: openaiModel,
    tools: [
      {
        type: 'web_search',
        search_context_size: 'medium',
        user_location: {
          type: 'approximate',
          country: 'US',
          region: 'Utah',
          city: 'Logan',
        },
      },
    ],
    tool_choice: 'required',
    input: [
      {
        role: 'system',
        content: `
You find current item-level grocery and household deals for Logan, Utah.

Only include specific item-level deals when actual item prices are present.
Do not invent prices.
Use web search to verify current public deals from official store pages, weekly ads, flyers, and public store pages.
Only search for and report these target stores:
${targetStores.map((storeName) => `- ${storeName}`).join('\n')}

Never report Food Lion, Aldi, Lidl, Walgreens, Target, Albertsons, Safeway, Publix, or other non-target stores.
Prefer official store pages. If an official page has no item prices, public weekly-ad mirrors are allowed only for target stores.
If a deal is not clearly current, mark the expiration as "verify in ad" instead of guessing.

Prioritize:
- chicken, lean beef, turkey, pork, fish, shrimp
- eggs, Greek yogurt, cottage cheese
- protein shakes and bars
- fruits, vegetables
- low-calorie sauces and zero-calorie drinks
- household essentials

Return only a JSON object. Do not wrap it in markdown.
Use this shape:
{
  "deals": [
    {
      "item": "string",
      "store": "one target store name exactly",
      "priceOrDiscount": "string",
      "expiration": "string",
      "recommendation": "Great deal | Good deal | Verify in ad",
      "reason": "short reason",
      "sourceUrl": "https://..."
    }
  ],
  "notes": ["string"]
}
`,
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            dateChecked: today,
            targetStores,
            suggestedSearches: searchInstructions,
            sourceDiagnostics,
            directFetchText: sourceResults.map((sourceResult) => ({
              storeName: sourceResult.storeName,
              targetStore: sourceResult.targetStore,
              url: sourceResult.url,
              text: sourceResult.text,
            })),
          },
          null,
          2
        ),
      },
    ],
  });
}

async function createReportWithoutWebSearch(sourceResults) {
  const today = formatDateForReport();
  const sourceDiagnostics = buildSourceDiagnostics(sourceResults);

  return openai.responses.create({
    model: openaiModel,
    input: [
      {
        role: 'system',
        content: `
You find current item-level grocery and household deals for Logan, Utah.

Only include specific item-level deals when actual item prices are present in the supplied source text.
Do not invent prices.
Only report these target stores:
${targetStores.map((storeName) => `- ${storeName}`).join('\n')}

Return only a JSON object. Do not wrap it in markdown.
Use this shape:
{
  "deals": [
    {
      "item": "string",
      "store": "one target store name exactly",
      "priceOrDiscount": "string",
      "expiration": "string",
      "recommendation": "Great deal | Good deal | Verify in ad",
      "reason": "short reason",
      "sourceUrl": "https://..."
    }
  ],
  "notes": ["OpenAI web search fallback was unavailable for this run, so this report only used direct page fetches."]
}
`,
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            dateChecked: today,
            targetStores,
            sourceDiagnostics,
            directFetchText: sourceResults.map((sourceResult) => ({
              storeName: sourceResult.storeName,
              targetStore: sourceResult.targetStore,
              url: sourceResult.url,
              text: sourceResult.text,
            })),
          },
          null,
          2
        ),
      },
    ],
  });
}

function sanitizeDealCandidates(candidateReport) {
  const deals = Array.isArray(candidateReport.deals) ? candidateReport.deals : [];

  return deals
    .map((deal) => {
      const targetStore = resolveTargetStoreName(String(deal.store ?? ''));

      if (!targetStore) {
        return null;
      }

      return {
        item: String(deal.item ?? '').trim(),
        store: targetStore,
        priceOrDiscount: String(deal.priceOrDiscount ?? '').trim(),
        expiration: String(deal.expiration ?? 'verify in ad').trim(),
        recommendation: String(deal.recommendation ?? 'Verify in ad').trim(),
        reason: String(deal.reason ?? '').trim(),
        sourceUrl: String(deal.sourceUrl ?? '').trim(),
      };
    })
    .filter((deal) => deal?.item && deal.priceOrDiscount);
}

function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMarkdownTable(rows) {
  if (rows.length === 0) {
    return 'No specific item-level prices or deals were available from the target Logan sources.';
  }

  return [
    '| Item | Store | Price/Discount | Expiration | Recommendation | Reason |',
    '|------|-------|----------------|------------|----------------|--------|',
    ...rows.map((deal) => {
      const source = deal.sourceUrl ? ` Source: ${deal.sourceUrl}` : '';
      return [
        '',
        deal.item,
        deal.store,
        deal.priceOrDiscount,
        deal.expiration,
        deal.recommendation,
        `${deal.reason}${source}`,
        '',
      ]
        .map(escapeMarkdownTableCell)
        .join(' | ');
    }),
  ].join('\n');
}

function renderDebugDiagnostics(sourceResults) {
  return [
    '| Store | URL | Status | Character Count | Real Weekly Ad Content | Error |',
    '|-------|-----|--------|-----------------|------------------------|-------|',
    ...sourceResults.map((sourceResult) => {
      const error = sourceResult.error ? sourceResult.error.replace(/\s+/g, ' ') : '';
      return [
        '',
        sourceResult.storeName,
        sourceResult.url,
        sourceResult.status,
        sourceResult.characterCount,
        sourceResult.realWeeklyAdContent ? 'Yes' : 'No',
        error,
        '',
      ]
        .map(escapeMarkdownTableCell)
        .join(' | ');
    }),
  ].join('\n');
}

function renderReport(candidateReport, sourceResults) {
  const today = formatDateForReport();
  const deals = sanitizeDealCandidates(candidateReport);
  const storesWithDeals = new Set(deals.map((deal) => deal.store));
  const storesWithoutDeals = targetStores.filter((storeName) => !storesWithDeals.has(storeName));
  const notes = Array.isArray(candidateReport.notes) ? candidateReport.notes.filter(Boolean) : [];

  return [
    '# Logan Grocery Deals',
    '',
    `Date checked: ${today}`,
    '',
    '## Specific Deals Found',
    '',
    formatMarkdownTable(deals),
    '',
    '## Stores With No Usable Item Prices',
    '',
    ...storesWithoutDeals.map((storeName) => `- ${storeName}`),
    '',
    notes.length > 0 ? '## Notes' : '',
    ...notes.map((note) => `- ${note}`),
    notes.length > 0 ? '' : '',
    '## Debug Source Diagnostics',
    '',
    renderDebugDiagnostics(sourceResults),
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

async function buildReport(sourceResults) {
  try {
    const response = await createReportWithWebSearch(sourceResults);
    return renderReport(extractJsonObject(response.output_text), sourceResults);
  } catch (error) {
    console.warn(`OpenAI web search report failed; retrying without web search: ${error.message}`);
  }

  try {
    const response = await createReportWithoutWebSearch(sourceResults);
    return renderReport(extractJsonObject(response.output_text), sourceResults);
  } catch (error) {
    console.warn(`Direct-fetch report parsing failed: ${error.message}`);

    return renderReport(
      {
        deals: [],
        notes: [
          'OpenAI did not return parseable structured deals, so this report only includes source diagnostics.',
        ],
      },
      sourceResults
    );
  }
}

async function fetchAllDealSources(browser) {
  return mapWithConcurrency(
    dealSources,
    sourceFetchConcurrency,
    async (source) => {
      const result = await fetchDealSource(source, browser);
      console.log(
        `${result.storeName}: ${result.status}, ${result.characterCount} chars, weekly ad=${result.realWeeklyAdContent}`
      );
      return result;
    }
  );
}


function buildEmailHtml(report) {
  const escapedReport = report
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  return `
<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.5;">
    <h2>Logan Grocery Deals</h2>
    <pre style="white-space: pre-wrap; font-family: Arial, sans-serif;">${escapedReport}</pre>
  </body>
</html>
`;
}

async function sendEmail(report) {
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const { error } = await resend.emails.send({
    from: 'Grocery Deals <onboarding@resend.dev>',
    to: process.env.DEAL_REPORT_TO_EMAIL,
    subject: `Logan Grocery Deals - ${today}`,
    text: report,
    html: buildEmailHtml(report),
  });

  if (error) {
    throw new Error(`Resend failed to send email: ${JSON.stringify(error)}`);
  }
}

async function main() {
  assertRequiredEnvironmentVariables();

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const sourceResults = await fetchAllDealSources(browser);

    const report = await buildReport(sourceResults);

    await sendEmail(report);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
