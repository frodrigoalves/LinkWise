import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const app = express();
const port = process.env.PORT || 3000; // Usa PORT do Render ou 3000 como fallback

const __dirname = path.resolve();
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload', upload.single('profiles'), (req, res) => {
  if (!req.file) {
    return res.status(400).send("Nenhum arquivo enviado.");
  }

  const tempPath = req.file.path;
  const targetPath = path.join(__dirname, 'linkedin_profiles.json');

  fs.copyFile(tempPath, targetPath, (copyErr) => {
    if (copyErr) {
      console.error("❌ Erro ao copiar arquivo:", copyErr);
      return res.status(500).send("Erro ao copiar arquivo.");
    }

    fs.unlink(tempPath, (unlinkErr) => {
      if (unlinkErr) {
        console.warn("⚠️ Erro ao remover temporário:", unlinkErr);
      }

      console.log("✅ Arquivo recebido. Executando análise com scrape.js...");
      exec('node scrape.js', (error, stdout, stderr) => {
        if (error) {
          console.error("❌ Erro no scrape.js:", error.message);
          return res.status(500).send(`<h2>❌ Erro ao executar a análise.</h2><pre>${error.message}</pre>`);
        }

        console.log(stdout);
        res.send(`<h1>✅ Perfis analisados com sucesso!</h1><pre>${stdout}</pre><a href="/">Voltar</a>`);
      });
    });
  });
});

app.listen(port, () => {
  console.log(`🚀 Servidor rodando: ${process.env.PORT || port}`);
});