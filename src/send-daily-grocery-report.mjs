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
const showDebugDetails = optionalEnvironmentVariable('SHOW_DEBUG_DETAILS') === 'true';
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function truncateText(value, maxLength = 140) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function recommendationScore(recommendation) {
  if (recommendation === 'Great deal') {
    return 100;
  }

  if (recommendation === 'Good deal') {
    return 70;
  }

  return 40;
}

function categorizeDeal(deal) {
  const haystack = `${deal.item} ${deal.reason}`.toLowerCase();

  if (/(chicken|beef|steak|roast|turkey|pork|ribs|shrimp|salmon|fish|sausage)/.test(haystack)) {
    return 'Protein';
  }

  if (/(egg|yogurt|cottage cheese|protein shake|protein bar|protein powder|muscle milk|quest|built|oikos|core power)/.test(haystack)) {
    return 'High-protein dairy and snacks';
  }

  if (/(blueberr|cherr|tomato|corn|salad|produce|fruit|vegetable)/.test(haystack)) {
    return 'Produce';
  }

  if (/(water|sparkling|powerade|zero sugar|drink)/.test(haystack)) {
    return 'Drinks';
  }

  if (/(toilet|paper towel|battery|batteries|vacuum|depend|poise|pull-ups|household)/.test(haystack)) {
    return 'Household';
  }

  return 'Other';
}

function categoryScore(category) {
  return {
    Protein: 35,
    'High-protein dairy and snacks': 30,
    Produce: 20,
    Household: 15,
    Drinks: 10,
    Other: 0,
  }[category] ?? 0;
}

function dealSortScore(deal) {
  const expirationPenalty = deal.expiration.toLowerCase().includes('verify') ? 5 : 0;
  return recommendationScore(deal.recommendation) + categoryScore(categorizeDeal(deal)) - expirationPenalty;
}

function sortDealsForReading(deals) {
  return [...deals].sort((firstDeal, secondDeal) => {
    const scoreDifference = dealSortScore(secondDeal) - dealSortScore(firstDeal);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    const storeDifference =
      targetStores.indexOf(firstDeal.store) - targetStores.indexOf(secondDeal.store);

    if (storeDifference !== 0) {
      return storeDifference;
    }

    return firstDeal.item.localeCompare(secondDeal.item);
  });
}

function groupDealsByStore(deals) {
  return targetStores.map((storeName) => ({
    storeName,
    deals: sortDealsForReading(deals.filter((deal) => deal.store === storeName)),
  }));
}

function groupDealsByCategory(deals) {
  const categories = [
    'Protein',
    'High-protein dairy and snacks',
    'Produce',
    'Household',
    'Drinks',
    'Other',
  ];

  return categories
    .map((category) => ({
      category,
      deals: sortDealsForReading(deals.filter((deal) => categorizeDeal(deal) === category)),
    }))
    .filter((group) => group.deals.length > 0);
}

function formatDealSource(deal) {
  return deal.sourceUrl ? ` Source: ${deal.sourceUrl}` : '';
}

function formatDealBullet(deal) {
  return `- [${deal.recommendation}] ${deal.item} - ${deal.priceOrDiscount}; expires ${deal.expiration}. ${truncateText(deal.reason, 180)}${formatDealSource(deal)}`;
}

function buildStoreSummary(storeSearchResults) {
  return targetStores.map((storeName) => {
    const storeResult = storeSearchResults.find((result) => result.targetStore === storeName);
    const deals = storeResult?.deals ?? [];
    const greatDealCount = deals.filter((deal) => deal.recommendation === 'Great deal').length;
    const bestDeals = sortDealsForReading(deals)
      .slice(0, 2)
      .map((deal) => `${deal.item} (${deal.priceOrDiscount})`);

    return {
      storeName,
      dealCount: deals.length,
      greatDealCount,
      status: storeResult?.status ?? 'not checked',
      bestDeals,
    };
  });
}

function getNoteworthyNotes(storeSearchResults) {
  return storeSearchResults.flatMap((storeResult) => {
    const needsContext =
      storeResult.deals.length === 0 ||
      storeResult.status.includes('failed') ||
      storeResult.status.includes('screenshot');

    if (!needsContext) {
      return [];
    }

    return storeResult.notes
      .slice(0, 2)
      .map((note) => `${storeResult.targetStore}: ${note}`);
  });
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

function renderSearchCoverageMarkdown(storeSearchResults) {
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

function renderSearchSourcesMarkdown(storeSearchResults) {
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

function getAllDeals(storeSearchResults) {
  return sortDealsForReading(storeSearchResults.flatMap((storeResult) => storeResult.deals));
}

function renderTextReport(sourceResults, storeSearchResults) {
  const today = formatDateForReport();
  const deals = getAllDeals(storeSearchResults);
  const storesWithDeals = new Set(deals.map((deal) => deal.store));
  const storesWithoutDeals = targetStores.filter((storeName) => !storesWithDeals.has(storeName));
  const bestDeals = sortDealsForReading(deals).slice(0, 12);
  const storeSummary = buildStoreSummary(storeSearchResults);
  const categoryGroups = groupDealsByCategory(deals);
  const storeGroups = groupDealsByStore(deals).filter((group) => group.deals.length > 0);
  const noteworthyNotes = getNoteworthyNotes(storeSearchResults);

  return [
    '# Logan Grocery Deals',
    '',
    `Date checked: ${today}`,
    `Deals found: ${deals.length} across ${storesWithDeals.size} stores.`,
    storesWithoutDeals.length > 0
      ? `No usable item prices found for: ${storesWithoutDeals.join(', ')}.`
      : 'Usable item prices found for every target store.',
    '',
    '## Best Deals First',
    '',
    ...(bestDeals.length > 0
      ? bestDeals.map((deal, index) => `${index + 1}. ${deal.store}: ${deal.item} - ${deal.priceOrDiscount} (${deal.recommendation}). ${truncateText(deal.reason, 160)}${formatDealSource(deal)}`)
      : ['No specific item-level prices or deals were available from the target Logan sources.']),
    '',
    '## Store Summary',
    '',
    ...storeSummary.map((summary) => {
      const bestDealsText =
        summary.bestDeals.length > 0 ? summary.bestDeals.join('; ') : 'No usable item prices';
      return `- ${summary.storeName}: ${summary.dealCount} deals (${summary.greatDealCount} great). ${bestDealsText}.`;
    }),
    '',
    '## Best Deals By Category',
    '',
    ...categoryGroups.flatMap((group) => [
      `### ${group.category}`,
      '',
      ...group.deals.slice(0, 8).map(formatDealBullet),
      '',
    ]),
    '## All Deals By Store',
    '',
    ...storeGroups.flatMap((group) => [
      `### ${group.storeName} (${group.deals.length})`,
      '',
      ...group.deals.map(formatDealBullet),
      '',
    ]),
    noteworthyNotes.length > 0 ? '## Data Quality Notes' : '',
    ...noteworthyNotes.map((note) => `- ${note}`),
    noteworthyNotes.length > 0 ? '' : '',
    '## Search Coverage',
    '',
    renderSearchCoverageMarkdown(storeSearchResults),
    showDebugDetails ? '' : '',
    showDebugDetails ? '## Search Sources' : '',
    showDebugDetails ? '' : '',
    showDebugDetails ? renderSearchSourcesMarkdown(storeSearchResults) : '',
    showDebugDetails ? '' : '',
    showDebugDetails ? '## Direct Source Diagnostics' : '',
    showDebugDetails ? '' : '',
    showDebugDetails ? renderDebugDiagnostics(sourceResults) : '',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}

function renderDealRowsHtml(deals, options = {}) {
  const { includeStore = true, compact = false } = options;

  if (deals.length === 0) {
    return '<p style="margin: 8px 0 0; color: #6b7280;">No usable item-level prices found.</p>';
  }

  const headers = [
    includeStore ? '<th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Store</th>' : '',
    '<th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Item</th>',
    '<th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Price</th>',
    compact ? '' : '<th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Why</th>',
  ].join('');

  const rows = deals.map((deal) => {
    const badgeColor = deal.recommendation === 'Great deal' ? '#166534' : '#374151';
    const sourceLink = deal.sourceUrl
      ? `<a href="${escapeHtml(deal.sourceUrl)}" style="color: #2563eb;">source</a>`
      : '';

    return `
      <tr>
        ${includeStore ? `<td style="padding: 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top;">${escapeHtml(deal.store)}</td>` : ''}
        <td style="padding: 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top;">
          <strong>${escapeHtml(deal.item)}</strong><br>
          <span style="color: ${badgeColor}; font-size: 12px;">${escapeHtml(deal.recommendation)}</span>
          <span style="color: #6b7280; font-size: 12px;"> · ${escapeHtml(deal.expiration)}</span>
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top;">${escapeHtml(deal.priceOrDiscount)}</td>
        ${compact ? '' : `<td style="padding: 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; color: #374151;">${escapeHtml(truncateText(deal.reason, 170))} ${sourceLink}</td>`}
      </tr>
    `;
  }).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; font-size: 14px;">
      <thead><tr>${headers}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderStoreSummaryHtml(storeSearchResults) {
  const rows = buildStoreSummary(storeSearchResults).map((summary) => {
    const bestDealsText =
      summary.bestDeals.length > 0
        ? summary.bestDeals.map(escapeHtml).join('<br>')
        : '<span style="color: #9ca3af;">No usable item prices</span>';

    return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;"><strong>${escapeHtml(summary.storeName)}</strong><br><span style="color: #6b7280; font-size: 12px;">${escapeHtml(summary.status)}</span></td>
        <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;">${summary.dealCount}</td>
        <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;">${summary.greatDealCount}</td>
        <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;">${bestDealsText}</td>
      </tr>
    `;
  }).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; font-size: 14px;">
      <thead>
        <tr>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Store</th>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Deals</th>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Great</th>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Best Finds</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderCoverageHtml(storeSearchResults) {
  const rows = storeSearchResults.map((storeResult) => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;">${escapeHtml(storeResult.targetStore)}</td>
      <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;">${escapeHtml(storeResult.status)}</td>
      <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;">${storeResult.deals.length}</td>
      <td style="padding: 8px; border-bottom: 1px solid #f3f4f6;">${storeResult.sources.length}</td>
    </tr>
  `).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; font-size: 13px;">
      <thead>
        <tr>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Store</th>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Status</th>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Deals</th>
          <th align="left" style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Sources</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderHtmlReport(sourceResults, storeSearchResults) {
  const today = formatDateForReport();
  const deals = getAllDeals(storeSearchResults);
  const bestDeals = deals.slice(0, 12);
  const categoryGroups = groupDealsByCategory(deals);
  const storeGroups = groupDealsByStore(deals).filter((group) => group.deals.length > 0);
  const storesWithDeals = new Set(deals.map((deal) => deal.store));
  const storesWithoutDeals = targetStores.filter((storeName) => !storesWithDeals.has(storeName));
  const noteworthyNotes = getNoteworthyNotes(storeSearchResults);

  return `
<!doctype html>
<html>
  <body style="margin: 0; padding: 0; background: #f9fafb; color: #111827; font-family: Arial, sans-serif; line-height: 1.45;">
    <div style="max-width: 920px; margin: 0 auto; padding: 24px 16px;">
      <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px;">
        <h1 style="margin: 0 0 4px; font-size: 24px;">Logan Grocery Deals</h1>
        <p style="margin: 0; color: #6b7280;">${escapeHtml(today)} · ${deals.length} deals across ${storesWithDeals.size} stores</p>
        ${storesWithoutDeals.length > 0 ? `<p style="margin: 12px 0 0; color: #92400e;">No usable item prices found for: ${escapeHtml(storesWithoutDeals.join(', '))}.</p>` : ''}
      </div>

      <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-top: 16px;">
        <h2 style="margin: 0 0 12px; font-size: 18px;">Best Deals First</h2>
        ${renderDealRowsHtml(bestDeals)}
      </div>

      <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-top: 16px;">
        <h2 style="margin: 0 0 12px; font-size: 18px;">Store Summary</h2>
        ${renderStoreSummaryHtml(storeSearchResults)}
      </div>

      <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-top: 16px;">
        <h2 style="margin: 0 0 12px; font-size: 18px;">Best Deals By Category</h2>
        ${categoryGroups.map((group) => `
          <h3 style="margin: 18px 0 8px; font-size: 15px;">${escapeHtml(group.category)}</h3>
          ${renderDealRowsHtml(group.deals.slice(0, 8), { compact: true })}
        `).join('')}
      </div>

      <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-top: 16px;">
        <h2 style="margin: 0 0 12px; font-size: 18px;">All Deals By Store</h2>
        ${storeGroups.map((group) => `
          <h3 style="margin: 18px 0 8px; font-size: 15px;">${escapeHtml(group.storeName)} (${group.deals.length})</h3>
          ${renderDealRowsHtml(group.deals, { includeStore: false })}
        `).join('')}
      </div>

      ${noteworthyNotes.length > 0 ? `
        <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 20px; margin-top: 16px;">
          <h2 style="margin: 0 0 8px; font-size: 18px;">Data Quality Notes</h2>
          <ul style="margin: 0; padding-left: 20px;">
            ${noteworthyNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}

      <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-top: 16px;">
        <h2 style="margin: 0 0 12px; font-size: 18px;">Search Coverage</h2>
        ${renderCoverageHtml(storeSearchResults)}
      </div>

      ${showDebugDetails ? `
        <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-top: 16px;">
          <h2 style="margin: 0 0 12px; font-size: 18px;">Debug Details</h2>
          <pre style="white-space: pre-wrap; font-family: Menlo, Consolas, monospace; font-size: 12px; color: #374151;">${escapeHtml(renderSearchSourcesMarkdown(storeSearchResults))}

${escapeHtml(renderDebugDiagnostics(sourceResults))}</pre>
        </div>
      ` : ''}
    </div>
  </body>
</html>
`;
}

function renderReport(sourceResults, storeSearchResults) {
  return {
    text: renderTextReport(sourceResults, storeSearchResults),
    html: renderHtmlReport(sourceResults, storeSearchResults),
  };
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
  if (typeof report === 'object' && report.html) {
    return report.html;
  }

  const escapedReport = escapeHtml(report);

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

function getReportText(report) {
  return typeof report === 'object' && report.text ? report.text : report;
}

async function sendEmail(report) {
  const reportText = getReportText(report);

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
    text: reportText,
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
