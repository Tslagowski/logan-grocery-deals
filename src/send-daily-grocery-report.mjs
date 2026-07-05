import OpenAI from 'openai';
import { Resend } from 'resend';
import { chromium } from 'playwright';

function optionalEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

const openaiModel = optionalEnvironmentVariable('OPENAI_MODEL') ?? 'gpt-4.1-mini';
const openaiSearchModel =
  optionalEnvironmentVariable('OPENAI_SEARCH_MODEL') ?? openaiModel;
const sourceFetchConcurrency = 3;
const storeSearchConcurrency = 2;
const enableScreenshotOcr = optionalEnvironmentVariable('ENABLE_SCREENSHOT_OCR') !== 'false';
const requestedMaxDealsPerStore = Number.parseInt(
  optionalEnvironmentVariable('MAX_DEALS_PER_STORE') ?? '20',
  10
);
const maxDealsPerStore =
  Number.isFinite(requestedMaxDealsPerStore) && requestedMaxDealsPerStore > 0
    ? requestedMaxDealsPerStore
    : 20;

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

const storeSearchConfigs = [
  {
    targetStore: "Smith's Food and Drug",
    queries: [
      "Smith's Food and Drug Logan Utah weekly ad item prices",
      "Smith's Food and Drug Logan Utah weekly digital deals",
      'Kroger Smiths Logan Utah weekly ad grocery prices',
    ],
    allowedDomains: ['smithsfoodanddrug.com', 'kroger.com', 'weekly-ads.us'],
  },
  {
    targetStore: "Macey's",
    queries: [
      "Macey's Logan Utah weekly ad item prices",
      "Macey's grocery weekly ad Logan Utah",
    ],
    allowedDomains: ['maceys.com', 'shop.maceys.com', 'weeklyad.io'],
  },
  {
    targetStore: "Lee's Marketplace",
    queries: [
      "Lee's Marketplace Logan Utah weekly ad item prices",
      "Lee's Marketplace Logan weekly ad grocery deals",
    ],
    allowedDomains: [
      'leesmarketplace.com',
      'shop.leesmarketplace.com',
      'ad.leesmarketplace.com',
    ],
  },
  {
    targetStore: "Ridley's",
    queries: [
      "Ridley's Logan Utah RPerks weekly ad item prices",
      "Ridley's Family Markets Logan Utah weekly ad grocery deals",
    ],
    allowedDomains: ['shopridleys.com', 'ridleys.com', 'rperks.shopridleys.com'],
  },
  {
    targetStore: 'Costco',
    queries: [
      'Costco Logan Utah warehouse savings grocery household prices',
      'Costco warehouse savings grocery household current deals',
    ],
    allowedDomains: ['costco.com'],
  },
  {
    targetStore: 'Walmart Logan',
    queries: [
      'Walmart Logan Utah grocery deals item prices',
      'Walmart store 1888 Logan Utah grocery deals',
    ],
    allowedDomains: ['walmart.com'],
  },
];

const blockedSearchDomains = [
  'aldi.us',
  'foodlion.com',
  'lidl.com',
  'publix.com',
  'safeway.com',
  'target.com',
  'walgreens.com',
];

const dealSearchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['targetStore', 'deals', 'notes'],
  properties: {
    targetStore: { type: 'string' },
    deals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'item',
          'store',
          'priceOrDiscount',
          'expiration',
          'recommendation',
          'reason',
          'sourceUrl',
        ],
        properties: {
          item: { type: 'string' },
          store: { type: 'string' },
          priceOrDiscount: { type: 'string' },
          expiration: { type: 'string' },
          recommendation: {
            type: 'string',
            enum: ['Great deal', 'Good deal', 'Verify in ad'],
          },
          reason: { type: 'string' },
          sourceUrl: { type: 'string' },
        },
      },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

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

async function capturePageScreenshots(page) {
  if (!enableScreenshotOcr) {
    return [];
  }

  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 60,
      fullPage: false,
    });

    return [`data:image/jpeg;base64,${screenshot.toString('base64')}`];
  } catch (error) {
    console.warn(`Screenshot capture failed: ${error.message}`);
    return [];
  }
}

async function fetchDealSource(source, browser) {
  const page = await browser.newPage({
    viewport: {
      width: 1280,
      height: 1600,
    },
  });
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
    const screenshots = await capturePageScreenshots(page);

    return {
      ...source,
      ok: true,
      status: 'loaded',
      characterCount: combinedText.length,
      elapsedMs: Date.now() - startedAt,
      realWeeklyAdContent: looksLikeWeeklyAdText(combinedText),
      text: combinedText,
      screenshots,
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
      screenshots: [],
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
    screenshotCount: sourceResult.screenshots.length,
    error: sourceResult.error,
    preview: sourceResult.text.slice(0, 1000),
  }));
}

function getSourceResultsForStore(sourceResults, targetStore) {
  return sourceResults.filter((sourceResult) => sourceResult.targetStore === targetStore);
}

function extractResponseUrls(response) {
  const urls = new Set();

  function visit(value) {
    if (!value) {
      return;
    }

    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) {
        urls.add(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  }

  visit(response.output);
  return Array.from(urls).slice(0, 30);
}

function isAllowedSourceUrl(sourceUrl, allowedDomains) {
  if (!sourceUrl) {
    return false;
  }

  try {
    const hostname = new URL(sourceUrl).hostname.replace(/^www\./, '');
    return allowedDomains.some((domain) => {
      const normalizedDomain = domain.replace(/^www\./, '');
      return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
    });
  } catch {
    return false;
  }
}

function sanitizeStoreDealCandidates(candidateReport, storeConfig) {
  return sanitizeDealCandidates(candidateReport)
    .filter((deal) => deal.store === storeConfig.targetStore)
    .filter((deal) => isAllowedSourceUrl(deal.sourceUrl, storeConfig.allowedDomains))
    .slice(0, maxDealsPerStore);
}

function buildStoreInputContent(storeConfig, storeSourceResults, sourceDiagnostics, includeScreenshots) {
  const content = [
    {
      type: 'input_text',
      text: JSON.stringify(
        {
          dateChecked: formatDateForReport(),
          targetStore: storeConfig.targetStore,
          searchQueries: storeConfig.queries,
          allowedDomains: storeConfig.allowedDomains,
          sourceDiagnostics,
          directFetchText: storeSourceResults.map((sourceResult) => ({
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
  ];

  if (!includeScreenshots) {
    return content;
  }

  for (const sourceResult of storeSourceResults) {
    sourceResult.screenshots.forEach((screenshot, screenshotIndex) => {
      content.push({
        type: 'input_text',
        text: `Rendered screenshot ${screenshotIndex + 1} from ${sourceResult.storeName}: ${sourceResult.url}. Use this URL as sourceUrl for deals found visually in this screenshot.`,
      });
      content.push({
        type: 'input_image',
        image_url: screenshot,
      });
    });
  }

  return content;
}

async function createStoreWebSearch(storeConfig, sourceResults) {
  const storeSourceResults = getSourceResultsForStore(sourceResults, storeConfig.targetStore);
  const sourceDiagnostics = buildSourceDiagnostics(storeSourceResults);

  return openai.responses.create({
    model: openaiSearchModel,
    tools: [
      {
        type: 'web_search',
        search_context_size: 'high',
        filters: {
          allowed_domains: storeConfig.allowedDomains,
          blocked_domains: blockedSearchDomains,
        },
        user_location: {
          type: 'approximate',
          country: 'US',
          region: 'Utah',
          city: 'Logan',
          timezone: 'America/Denver',
        },
      },
    ],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    text: {
      format: {
        type: 'json_schema',
        name: 'store_deal_search',
        strict: true,
        schema: dealSearchSchema,
      },
    },
    input: [
      {
        role: 'system',
        content: `
You find current item-level grocery and household deals for ${storeConfig.targetStore} in Logan, Utah.

Only include specific item-level deals when actual item prices are present.
Do not invent prices.
Search only for ${storeConfig.targetStore}. Ignore every other retailer.
Use official store pages first. Public weekly-ad mirrors are acceptable only when they clearly refer to ${storeConfig.targetStore}.
If a deal is not clearly current, mark the expiration as "verify in ad" instead of guessing.
Return up to ${maxDealsPerStore} item-level deals for this store.
Do not return generic rows like "various deals", "weekly ad", or "storewide sale".
Every deal must include a sourceUrl from one of the allowed domains.

Prioritize:
- chicken, lean beef, turkey, pork, fish, shrimp
- eggs, Greek yogurt, cottage cheese
- protein shakes and bars
- fruits, vegetables
- low-calorie sauces and zero-calorie drinks
- household essentials

Return JSON that matches the provided schema.
`,
      },
      {
        role: 'user',
        content: buildStoreInputContent(
          storeConfig,
          storeSourceResults,
          sourceDiagnostics,
          false
        ),
      },
    ],
  });
}

async function createStoreDirectExtraction(storeConfig, sourceResults) {
  const storeSourceResults = getSourceResultsForStore(sourceResults, storeConfig.targetStore);
  const sourceDiagnostics = buildSourceDiagnostics(storeSourceResults);

  return openai.responses.create({
    model: openaiModel,
    text: {
      format: {
        type: 'json_schema',
        name: 'store_deal_direct_extract',
        strict: true,
        schema: dealSearchSchema,
      },
    },
    input: [
      {
        role: 'system',
        content: `
You extract current item-level grocery and household deals for ${storeConfig.targetStore} in Logan, Utah from supplied source text.

Only include specific item-level deals when actual item prices are present in the supplied source text.
Do not invent prices.
Only report ${storeConfig.targetStore}.
Use screenshots when source text is thin or looks like an app shell.
Return up to ${maxDealsPerStore} item-level deals.
Return JSON that matches the provided schema.
`,
      },
      {
        role: 'user',
        content: buildStoreInputContent(
          storeConfig,
          storeSourceResults,
          sourceDiagnostics,
          true
        ),
      },
    ],
  });
}

function mergeDeals(dealGroups) {
  const seenDeals = new Set();
  const mergedDeals = [];

  for (const deal of dealGroups.flat()) {
    const dealKey = [
      normalizeStoreName(deal.store),
      normalizeStoreName(deal.item),
      normalizeStoreName(deal.priceOrDiscount),
    ].join('|');

    if (seenDeals.has(dealKey)) {
      continue;
    }

    seenDeals.add(dealKey);
    mergedDeals.push(deal);
  }

  return mergedDeals.slice(0, maxDealsPerStore);
}

async function searchStoreDeals(storeConfig, sourceResults) {
  let webSearchResult;

  try {
    const response = await createStoreWebSearch(storeConfig, sourceResults);
    const candidateReport = extractJsonObject(response.output_text);
    const deals = sanitizeStoreDealCandidates(candidateReport, storeConfig);

    webSearchResult = {
      targetStore: storeConfig.targetStore,
      status: 'web search',
      deals,
      notes: Array.isArray(candidateReport.notes) ? candidateReport.notes : [],
      sources: extractResponseUrls(response),
      error: '',
    };
  } catch (error) {
    console.warn(`${storeConfig.targetStore}: web search failed; trying direct extraction: ${error.message}`);
  }

  if (webSearchResult && (!enableScreenshotOcr || webSearchResult.deals.length >= 3)) {
    return webSearchResult;
  }

  try {
    const response = await createStoreDirectExtraction(storeConfig, sourceResults);
    const candidateReport = extractJsonObject(response.output_text);
    const directDeals = sanitizeStoreDealCandidates(candidateReport, storeConfig);
    const deals = mergeDeals([webSearchResult?.deals ?? [], directDeals]);

    return {
      targetStore: storeConfig.targetStore,
      status: webSearchResult ? 'web search + screenshot OCR' : 'direct screenshot OCR',
      deals,
      notes: [
        ...(webSearchResult?.notes ?? []),
        ...(webSearchResult ? [] : ['Web search failed for this store.']),
        ...(Array.isArray(candidateReport.notes) ? candidateReport.notes : []),
      ],
      sources: webSearchResult?.sources ?? [],
      error: '',
    };
  } catch (error) {
    if (webSearchResult) {
      return {
        ...webSearchResult,
        status: 'web search; screenshot OCR failed',
        notes: [
          ...webSearchResult.notes,
          `Screenshot OCR failed for this store: ${error.message}`,
        ],
      };
    }

    return {
      targetStore: storeConfig.targetStore,
      status: 'failed',
      deals: [],
      notes: ['No structured deal data could be extracted for this store.'],
      sources: [],
      error: error.message,
    };
  }
}

async function searchAllStores(sourceResults) {
  return mapWithConcurrency(
    storeSearchConfigs,
    storeSearchConcurrency,
    async (storeConfig) => {
      const result = await searchStoreDeals(storeConfig, sourceResults);
      console.log(
        `${result.targetStore}: ${result.status}, deals=${result.deals.length}, sources=${result.sources.length}`
      );
      return result;
    }
  );
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
    '| Store | URL | Status | Character Count | Screenshots | Real Weekly Ad Content | Error |',
    '|-------|-----|--------|-----------------|-------------|------------------------|-------|',
    ...sourceResults.map((sourceResult) => {
      const error = sourceResult.error ? sourceResult.error.replace(/\s+/g, ' ') : '';
      return [
        '',
        sourceResult.storeName,
        sourceResult.url,
        sourceResult.status,
        sourceResult.characterCount,
        sourceResult.screenshots.length,
        sourceResult.realWeeklyAdContent ? 'Yes' : 'No',
        error,
        '',
      ]
        .map(escapeMarkdownTableCell)
        .join(' | ');
    }),
  ].join('\n');
}

function renderSearchCoverage(storeSearchResults) {
  return [
    '| Store | Search Status | Deals Found | Sources Seen | Error |',
    '|-------|---------------|-------------|--------------|-------|',
    ...storeSearchResults.map((storeResult) => [
      '',
      storeResult.targetStore,
      storeResult.status,
      storeResult.deals.length,
      storeResult.sources.length,
      storeResult.error,
      '',
    ]
      .map(escapeMarkdownTableCell)
      .join(' | ')),
  ].join('\n');
}

function renderSearchSources(storeSearchResults) {
  const lines = storeSearchResults.flatMap((storeResult) => {
    if (storeResult.sources.length === 0) {
      return [];
    }

    return [
      `- ${storeResult.targetStore}:`,
      ...storeResult.sources.slice(0, 8).map((sourceUrl) => `  - ${sourceUrl}`),
    ];
  });

  return lines.length > 0 ? lines.join('\n') : 'No web-search source URLs were returned.';
}

function renderReport(sourceResults, storeSearchResults) {
  const today = formatDateForReport();
  const deals = storeSearchResults
    .flatMap((storeResult) => storeResult.deals)
    .sort(
      (firstDeal, secondDeal) =>
        targetStores.indexOf(firstDeal.store) - targetStores.indexOf(secondDeal.store)
    );
  const storesWithDeals = new Set(deals.map((deal) => deal.store));
  const storesWithoutDeals = targetStores.filter((storeName) => !storesWithDeals.has(storeName));
  const notes = storeSearchResults.flatMap((storeResult) =>
    storeResult.notes.map((note) => `${storeResult.targetStore}: ${note}`)
  );

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
    '## Search Coverage',
    '',
    renderSearchCoverage(storeSearchResults),
    '',
    '## Search Sources',
    '',
    renderSearchSources(storeSearchResults),
    '',
    '## Direct Source Diagnostics',
    '',
    renderDebugDiagnostics(sourceResults),
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

async function buildReport(sourceResults) {
  const storeSearchResults = await searchAllStores(sourceResults);
  return renderReport(sourceResults, storeSearchResults);
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
  let sourceResults;

  try {
    sourceResults = await fetchAllDealSources(browser);
  } finally {
    await browser.close();
  }

  const report = await buildReport(sourceResults);
  await sendEmail(report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
