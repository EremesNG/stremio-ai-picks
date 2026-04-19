FROM node:23
WORKDIR /usr/src/app
COPY package*.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
EXPOSE 7000
ENV NODE_ENV=production
ENV ENABLE_LOGGING=false
RUN mkdir -p logs
CMD ["node", "server.js"] 