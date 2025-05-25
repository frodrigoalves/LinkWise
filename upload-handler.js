import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __dirname = path.resolve();
const uploadDir = path.join(__dirname, 'uploads');
const leadsOutputPath = path.join(__dirname, 'public', 'leads_output.json');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

app.get('/leads_output.json', (req, res) => {
  if (fs.existsSync(leadsOutputPath)) {
    res.sendFile(leadsOutputPath);
  } else {
    res.status(404).send('Leads output not found.');
  }
});

app.post('/generate-profiles', async (req, res) => {
  const { profileType, ageRange, gender, region, industry, numLinks } = req.body;
  if (!profileType || !ageRange || !gender || !region || !industry || !numLinks) {
    return res.status(400).send('Todos os critérios são obrigatórios.');
  }

  const num = Math.min(Math.max(parseInt(numLinks, 10), 1), 10); // Limita entre 1 e 10

  try {
    const prompt = `Gere uma lista de ${num} URLs fictícias realistas de perfis do LinkedIn com base nos seguintes critérios: 
      Tipo de Perfil: ${profileType}, 
      Faixa Etária: ${ageRange}, 
      Sexo: ${gender}, 
      Continente/Idioma: ${region} (ex.: América do Norte usa EN, Europa usa EN/FR/DE, Ásia usa EN/JA, América do Sul usa PT/ES), 
      Tipo de Atuação: ${industry}. 
      Retorne apenas um array de objetos no formato JSON com a propriedade 'url', usando o padrão https://www.linkedin.com/in/nome-ficticio/.`;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 200
    });

    const content = response.choices[0].message.content;
    const profiles = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] || '[]');

    if (!profiles.length) {
      return res.status(500).send('Nenhuma URL gerada pelo GPT.');
    }

    const targetPath = path.join(__dirname, 'linkedin_profiles.json');
    fs.writeFileSync(targetPath, JSON.stringify(profiles, null, 2));
    console.log('✅ Arquivo linkedin_profiles.json gerado com URLs fictícias.');

    const scriptPath = path.join(__dirname, 'src', 'scrape.js');
    exec('npx puppeteer browsers install chrome', (installError) => {
      if (installError) {
        console.error('❌ Erro ao instalar Chrome:', installError.message);
        return res.status(500).send(`<h2>❌ Erro ao instalar Chrome</h2><pre>${installError.message}</pre>`);
      }
      exec(`SHOW_BROWSER=true node ${scriptPath}`, async (error, stdout, stderr) => {
        if (error) {
          console.error('❌ Erro no scraper:', error.message);
          return res.status(500).send(`<h2>❌ Erro ao executar a análise.</h2><pre>${error.message}</pre>`);
        }

        console.log(stdout);

        if (fs.existsSync(leadsOutputPath)) {
          const data = JSON.parse(fs.readFileSync(leadsOutputPath, 'utf-8'));
          const { error: insertError } = await supabase.from('leads').insert(data);
          if (insertError) {
            console.error('❌ Erro ao inserir no Supabase:', insertError.message);
            return res.status(500).send(`<h2>❌ Erro ao inserir no Supabase</h2><pre>${insertError.message}</pre>`);
          }
          console.log('✅ Leads inseridos com sucesso no Supabase.');
        }

        res.send(`<h1>✅ Perfis analisados com sucesso!</h1><pre>${stdout}</pre><a href="/">Voltar</a>`);
      });
    });
  } catch (err) {
    console.error('❌ Erro ao gerar perfis:', err.message);
    res.status(500).send(`<h2>❌ Erro ao gerar perfis</h2><pre>${err.message}</pre>`);
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor ativo na porta ${port}`);
});