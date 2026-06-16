# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Your app binds to port 8080, so let's document that
# EXPOSE 8080
# Note: The replicator.js doesn't seem to expose a port, but if it did, you would uncomment the line above.

# Define the command to run your app
CMD ["node", "replicator.js"]
