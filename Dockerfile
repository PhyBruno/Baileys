# node:22-slim (Debian/glibc) em vez de alpine: o baileys puxa o sharp como
# dependência transitiva, e o sharp resolve binários pré-compilados com mais
# previsibilidade em glibc do que em musl (alpine). Não precisa de toolchain
# de build — tudo aqui é binário pronto ou WASM.
FROM node:22-slim

WORKDIR /app

# Copia só os manifests primeiro pra aproveitar cache de camada: só reinstala
# dependências quando package.json/package-lock.json mudam, não a cada
# alteração de código.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Roda sem privilégio de root — a imagem base já vem com o usuário "node".
# A aplicação não escreve nada em disco (todo o estado vai pro Postgres), então
# não precisa de volume nem de ajuste de dono de diretório.
USER node

# Usa o endpoint /health (sem autenticação) e o fetch nativo do Node — sem
# depender de curl/wget instalados na imagem.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
