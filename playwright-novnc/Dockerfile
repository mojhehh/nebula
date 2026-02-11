# Playwright + noVNC Docker Image
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

# Prevent interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Install VNC and noVNC dependencies
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app

# Copy application files
COPY package.json ./
COPY server.js ./
COPY public ./public

# Install Node dependencies
RUN npm install

# Create supervisor config
RUN mkdir -p /var/log/supervisor

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose ports: 3000 (app), 6080 (noVNC web), 5900 (VNC)
EXPOSE 3000 6080 5900

# Set display
ENV DISPLAY=:99

# Start supervisor (manages all processes)
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
