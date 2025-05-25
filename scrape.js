import puppeteer from 'puppeteer';
import fs from 'fs';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: './.env' });

if (
  !process.env.OPENAI_API_KEY ||
  !process.env.VITE_LINKEDIN_EMAIL ||
  !process.env.VITE_LINKEDIN_PASSWORD ||
  !process.env.VITE_SUPABASE_URL ||
  !process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
) {
  console.error("❌ Missing credentials.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
);

const leads = JSON.parse(fs.readFileSync('linkedin_profiles.json', 'utf-8')).slice(0, 20);

async function autoLogin(page) {
  try {
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'networkidle2',
      timeout: 90000
    });

    await page.waitForSelector('#username', { timeout: 30000 });
    await page.type('#username', process.env.VITE_LINKEDIN_EMAIL, { delay: 150 });
    await page.type('#password', process.env.VITE_LINKEDIN_PASSWORD, { delay: 150 });
    await page.click('button[type="submit"]');

    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 90000 });
    console.log("✅ Logged in successfully to LinkedIn.");
  } catch (error) {
    console.error("❌ Login failed:", error.message);
    process.exit(1);
  }
}

async function scoreLead(bio) {
  if (!bio || bio.length < 80) return { angelScore: 0, icpScore: 0, finalScore: 0 };

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You're an expert in startup evaluation. Return only JSON with 'angelScore' and 'icpScore' from 0 to 10 based on the bio."
        },
        { role: "user", content: bio }
      ],
      temperature: 0.7
    });

    const content = response.choices[0].message.content || '{}';
    const match = content.match(/\{[\s\S]*\}/);
    const jsonString = match ? match[0] : '{}';
    const { angelScore, icpScore } = JSON.parse(jsonString);

    return {
      angelScore: parseFloat(angelScore) || 0,
      icpScore: parseFloat(icpScore) || 0,
      finalScore: ((parseFloat(angelScore) || 0) + (parseFloat(icpScore) || 0)) / 2
    };
  } catch (error) {
    console.error("❌ Failed to score profile:", error.message);
    return { angelScore: 0, icpScore: 0, finalScore: 0 };
  }
}

async function generateConnectionMessage(bio, name, angelScore) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a startup founder using LinkWise (Superland) to connect with angel investors. Generate a concise LinkedIn connection request (max 300 characters) that is professional, personalized, and invites collaboration. Use the lead's name, bio, and angelScore (0-10) to tailor the message. Highlight startup investment opportunities and keep the tone enthusiastic yet respectful."
        },
        {
          role: "user",
          content: `Name: ${name}, Bio: ${bio}, AngelScore: ${angelScore}`
        }
      ],
      temperature: 0.5,
      max_tokens: 100
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Failed to generate message:", error.message);
    return `Hi ${name}, I’m with LinkWise (Superland) and admire your startup expertise. Let’s connect to explore investment opportunities!`;
  }
}

async function scrapeProfile(url, page) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const name = await page.$eval('.text-heading-xlarge', el => el.textContent.trim()).catch(() => 'Name not found');
    const bio = await page.$eval('div[data-section="about"] .pv-about__summary-text', el => el.textContent.trim())
      .catch(() => page.$eval('section[class*="pv-about-section"] .text-body-medium', el => el.textContent.trim()))
      .catch(() => 'Bio not found');

    return {
      name: name.replace(/\s+/g, ' ').trim(),
      bio: bio.replace(/\s+/g, ' ').trim()
    };
  } catch (error) {
    console.error(`❌ Error loading profile ${url}:`, error.message);
    return { name: 'Error', bio: 'Bio not found' };
  }
}

async function sendConnectionRequest(page, url, name, bio, angelScore) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const connectBtn = await page.$('button[aria-label*="Invite"]');
    if (connectBtn) {
      await connectBtn.click();

      const addNoteBtn = await page.waitForSelector('button[aria-label="Add a note"]', { timeout: 5000 }).catch(() => null);
      if (addNoteBtn) {
        await addNoteBtn.click();
        const message = await generateConnectionMessage(bio, name, angelScore);
        await page.type('#connect-cta-form__invitation', message, { delay: 50 });
      }

      const sendBtn = await page.waitForSelector('button[aria-label="Send now"]', { timeout: 5000 }).catch(() => null);
      if (sendBtn) {
        await sendBtn.click();
        console.log(`🤝 Connection request sent to ${name}: ${message}`);
      } else {
        console.log(`⚠️ Cannot send invite to ${name}`);
      }
    } else {
      console.log(`⚠️ No connect button found for ${name}`);
    }

    await new Promise(r => setTimeout(r, 5000));
  } catch (error) {
    console.error(`❌ Error connecting to ${name}:`, error.message);
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    slowMo: 50,
    args: ['--start-maximized', '--disable-notifications']
  });

  const page = await browser.newPage();
  await autoLogin(page);

  const results = [];

  for (const url of leads) {
    const { name, bio } = await scrapeProfile(url, page);
    const score = await scoreLead(bio);

    const lead = {
      name,
      bio,
      url,
      platform: "LinkedIn",
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@mockemail.com`, // Mock email
      angelscore: score.angelScore,
      icpscore: score.icpScore,
      finalscore: score.finalScore,
      tags: "auto",
      meeting_scheduled: false,
      meeting_time: null
    };

    console.log(`📊 ${name} – Angel: ${score.angelScore} | ICP: ${score.icpScore}`);

    const { error } = await supabase.from('leads').insert(lead);
    if (error) {
      console.error(`❌ Failed to insert ${name} into Supabase:`, error.message);
    } else {
      console.log(`✅ Successfully inserted ${name} into Supabase`);
    }

    results.push(lead);

    if (score.angelScore >= 7) {
      await sendConnectionRequest(page, url, name, bio, score.angelScore);
    } else {
      console.log(`⛔️ Skipped ${name}, angelScore too low (${score.angelScore})`);
    }
  }

  fs.writeFileSync('public/leads_output.json', JSON.stringify(results, null, 2));
  await browser.close();
  console.log("✅ All profiles processed.");
}

main();