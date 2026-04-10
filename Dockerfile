FROM node:20-slim AS base
RUN npm install -g pnpm@10.4.1
WORKDIR /app
COPY package.json ./
COPY patches/ ./patches/
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN mkdir -p dist/public && echo '<!DOCTYPE html><html><body><h1>PropDealHub API</h1></body></html>' > dist/public/index.html
RUN npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist
EXPOSE ${PORT:-3000}
CMD ["node", "dist/index.js"]
