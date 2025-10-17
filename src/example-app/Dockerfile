# Use the official Node.js 18 image as base
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Set build-time environment variables (optional - only if needed during build)
# ARG OPENAI_API_KEY
# ENV OPENAI_API_KEY=$OPENAI_API_KEY

# Build the application
RUN pnpm build

# Expose port 3002 (as specified in package.json)
EXPOSE 3002

# Start the application
CMD ["pnpm", "start"]
