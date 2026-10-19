FROM node:22-alpine

WORKDIR /app

# Copy application files
COPY package.json config.json server.js ./

# Set environment
ENV NODE_ENV=production
ENV OPENCODE_BRIDGE_PORT=8318
ENV OPENCODE_BRIDGE_HOST=0.0.0.0

EXPOSE 8318

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8318/health || exit 1

CMD ["node", "server.js"]
