import puppeteer from 'puppeteer';
import fs from 'fs';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'VITE_LINKEDIN_EMAIL',
  'VITE_LINKEDIN_PASSWORD',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_SERVICE_ROLE_KEY'
];

const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length) {
  console.error('❌ Variáveis ausentes:', missing);
  process.exit(1);
}

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sanitizeName(name) {
  return name.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
}

async function loginLinkedIn(page) {
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: 12000 });
  await page.type('#username', process.env.VITE_LINKEDIN_EMAIL, { delay: 150 });
  await page.type('#password', process.env.VITE_LINKEDIN_PASSWORD, { delay: 150 });

  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 })
  ]);

  await page.waitForTimeout(5000);
  console.log('✅ Login efetuado com sucesso.');
}

async function getBio(page) {
  try {
    await page.waitForSelector('.text-body-medium.break-words', { timeout: 10000 });
    const bio = await page.$eval('.text-body-medium.break-words', el => el.innerText.trim());
    return bio;
  } catch {
    return '';
  }
}

async function scoreBio(bio) {
  if (!bio || bio.length < 50) return { angelScore: 1, icpScore: 1, finalScore: 1 };

  const prompt = `Perfil: ${bio}\nAvalie com notas de 0 a 10:\n- Fit com startups (Angel Score)\n- Fit com nosso ICP (ICP Score)`;

  const res = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: prompt }]
  });

  const msg = res.choices[0].message.content;
  const angel = Number(msg.match(/Angel Score[:\s]+(\d+)/i)?.[1] || 0);
  const icp = Number(msg.match(/ICP Score[:\s]+(\d+)/i)?.[1] || 0);
  const final = (angel + icp) / 2;

  return { angelScore: angel, icpScore: icp, finalScore: final };
}

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    slowMo: 50,
    args: ['--start-maximized', '--disable-notifications']
  });

  const page = await browser.newPage();
  await loginLinkedIn(page).catch(() => process.exit(1));

  const leadsRaw = JSON.parse(fs.readFileSync('linkedin_profiles.json', 'utf8'));
  const results = [];

  for (const lead of leadsRaw) {
    const { name, url, email } = lead;
    try {
      console.log(`🔎 Visitando ${name}...`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForTimeout(1500);
      const bio = await getBio(page);
      const { angelScore, icpScore, finalScore } = await scoreBio(bio);

      results.push({
        name: sanitizeName(name),
        url,
        email,
        bio,
        angelScore,
        icpScore,
        finalScore,
        tags: [],
        created_at: new Date().toISOString()
      });
    } catch (err) {
      console.warn(`⚠️ Falha ao processar ${name}:`, err.message);
    }
  }

  await browser.close();
  fs.writeFileSync('leads_output.json', JSON.stringify(results, null, 2));
  console.log(`✅ ${results.length} leads salvos em leads_output.json`);

  const validLeads = results.filter(l => l.name && l.url && l.finalScore);
  if (!validLeads.length) {
    console.warn('⚠️ Nenhum lead válido para enviar.');
    return;
  }

  const { error } = await supabase.from('leads').insert(validLeads);
  if (error) {
    console.error('❌ Supabase erro:', error.message);
  } else {
    console.log('🚀 Leads enviados ao Supabase com sucesso.');
  }
}

main().catch(err => {
  console.error('❌ Processo principal falhou:', err.message);
  process.exit(1);
});
