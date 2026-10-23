# node:22-slim (Debian/glibc) em vez de alpine: o baileys puxa o sharp como
# dependência transitiva, e o sharp resolve binários pré-compilados com mais
# previsibilidade em glibc do que em musl (alpine). Não precisa de toolchain
# de build — tudo aqui é binário pronto ou WASM.
#
# Versão exata + digest: "node:22-slim" sozinho muda a cada patch publicado,
# então dois builds do mesmo commit podiam sair com Node/Debian diferentes (e
# uma imagem base trocada no registry passaria despercebida). Para atualizar:
#   docker pull node:22-slim
#   docker image inspect node:22-slim --format '{{index .RepoDigests 0}}'
#   docker run --rm node:22-slim node --version
ARG NODE_IMAGE=node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Estágio 1: build da tela de configuração (manager/, Vite + React). As
# dependências de front ficam só neste estágio: a imagem final leva apenas os
# estáticos de manager/dist, sem node_modules do front.
FROM ${NODE_IMAGE} AS manager-build

WORKDIR /manager
COPY manager/package.json manager/package-lock.json ./
RUN npm ci
COPY manager/ .
RUN npm run build

# Estágio 2: a bridge.
FROM ${NODE_IMAGE}

WORKDIR /app

# Copia só os manifests primeiro pra aproveitar cache de camada: só reinstala
# dependências quando package.json/package-lock.json mudam, não a cada
# alteração de código.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Só o que roda: os módulos (estrutura plana na raiz) e o schema. Nada de
# test/, do código-fonte do manager nem de docs — se um dia houver módulos em
# subpasta, inclua a pasta aqui.
COPY *.js schema.sql ./
COPY --from=manager-build /manager/dist ./manager/dist

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
