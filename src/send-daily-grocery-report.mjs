import OpenAI from 'openai';
import sendGridMail from '@sendgrid/mail';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

sendGridMail.setApiKey(process.env.SENDGRID_API_KEY);

const dealSources = [
  {
    storeName: "Smith's",
    url: 'https://www.smithsfoodanddrug.com/weeklyad',
  },
  {
    storeName: "Macey's",
    url: 'https://www.maceys.com/weekly-ad',
  },
  {
    storeName: "Lee's Marketplace",
    url: 'https://www.leesmarketplace.com/weekly-ad',
  },
  {
    storeName: "Ridley's Family Market",
    url: 'https://shopridleys.com/weekly-ad',
  },
  {
    storeName: 'Costco',
    url: 'https://www.costco.com/warehouse-savings.html',
  },
  {
    storeName: 'Walmart Logan',
    url: 'https://www.walmart.com/store/1888-logan-ut',
  },
];

async function fetchDealSourceText(source) {
  const response = await fetch(source.url, {
    headers: {
      'user-agent': 'Mozilla/5.0 grocery-deal-checker',
    },
  });

  if (!response.ok) {
    return `${source.storeName}: Unable to fetch ${source.url}. Status ${response.status}`;
  }

  const html = await response.text();

  return `
STORE: ${source.storeName}
URL: ${source.url}
RAW_PAGE_TEXT:
${html.slice(0, 12000)}
`;
}

async function buildReport(sourceTexts) {
  const response = await openai.responses.create({
    model: 'gpt-5.5',
    input: [
      {
        role: 'system',
        content: `
You create concise grocery deal reports for Logan, Utah.

Only include specific item-level deals.
Do not include generic summaries.
Prioritize weight-lifting nutrition:
- chicken, lean beef, turkey, pork, fish, shrimp
- eggs, Greek yogurt, cottage cheese
- protein shakes and bars only when legitimately discounted
- fruits, vegetables
- low-calorie sauces and zero-calorie drinks
- household essentials

For each deal include:
Item | Store | Price/Discount | Expiration if known | Buy/Skip/Stock-up | Reason

Call out when data is unavailable.
Do not invent prices.
`,
      },
      {
        role: 'user',
        content: sourceTexts.join('\n\n'),
      },
    ],
  });

  return response.output_text;
}

async function sendEmail(report) {
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  await sendGridMail.send({
    to: process.env.DEAL_REPORT_TO_EMAIL,
    from: process.env.DEAL_REPORT_FROM_EMAIL,
    subject: `Logan Grocery Deals - ${today}`,
    text: report,
  });
}

async function main() {
  const sourceTexts = await Promise.all(
    dealSources.map((source) => fetchDealSourceText(source))
  );

  const report = await buildReport(sourceTexts);

  await sendEmail(report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});