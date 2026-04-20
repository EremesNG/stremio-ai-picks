# Alternative self-hosting via Docker (primary deployment is Vercel)
FROM node:23
WORKDIR /usr/src/app
COPY package*.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
ENV ENABLE_LOGGING=false
RUN mkdir -p logs
CMD ["node", "server.js"] 