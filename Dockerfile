FROM node:20-alpine
WORKDIR /app
COPY server.js admin.html admin-manifest.webmanifest admin-sw.js .
COPY admin-icon-192.png admin-icon-512.png admin-apple-touch.png .
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
