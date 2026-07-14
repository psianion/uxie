FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json bunfig.toml* ./
COPY src ./src
USER bun
CMD ["bun", "run", "src/index.ts"]
