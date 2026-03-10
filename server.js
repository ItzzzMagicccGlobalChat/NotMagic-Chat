const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Banned words for auto-moderation
const bannedWords = ['badword1', 'badword2', 'inappropriate', 'spam', 'nsfw', 'explicit'];
const users = new Map();
const bannedUsers = new Set();
const timedOutUsers = new Map();
const userWarnings = new Map();

// Sanitize messages
function sanitizeMessage(text) {
    if (!text) return '';
    let sanitized = text;
    for (let word of bannedWords) {
        const regex = new RegExp(word, 'gi');
        sanitized = sanitized.replace(regex, '***');
    }
    return sanitized;
}

// Socket.io Connection
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    // User joins chat
    socket.on('user_join', (username) => {
        // Check if user is banned
        if (bannedUsers.has(username)) {
            socket.emit('error_message', '🚫 You are banned from this chat.');
            socket.disconnect();
            return;
        }

        // Store user info
        users.set(socket.id, {
            username: username,
            rank: 'User',
            socketId: socket.id,
            warnings: userWarnings.get(username) || 0
        });

        // Broadcast user joined
        io.emit('user_joined', {
            username: username,
            message: `${username} joined the chat`,
            timestamp: new Date().toLocaleTimeString()
        });

        // Send list of online users
        io.emit('users_list', Array.from(users.values()));
        console.log(`👤 ${username} joined`);
    });

    // Receive chat message
    socket.on('chat_message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        // Check if user is banned
        if (bannedUsers.has(user.username)) {
            socket.emit('error_message', '🚫 You are banned');
            return;
        }

        // Check if user is timed out
        if (timedOutUsers.has(user.username)) {
            socket.emit('error_message', '⏱️ You are timed out');
            return;
        }

        // Check warnings (3 warnings = auto-ban)
        if (userWarnings.get(user.username) >= 3) {
            bannedUsers.add(user.username);
            socket.emit('error_message', '🚫 You have been banned (3 warnings)');
            return;
        }

        const sanitized = sanitizeMessage(data.message);
        
        // Broadcast message to all users
        io.emit('chat_message', {
            username: user.username,
            rank: user.rank,
            message: sanitized,
            timestamp: new Date().toLocaleTimeString(),
            image: data.image || null,
            channel: data.channel || 'global'
        });

        console.log(`💬 ${user.username}: ${sanitized}`);
    });

    // Direct Message
    socket.on('send_dm', (data) => {
        const sender = users.get(socket.id);
        if (!sender) return;

        // Find recipient socket
        let recipientSocket = null;
        for (let [socketId, user] of users) {
            if (user.username === data.recipient) {
                recipientSocket = socketId;
                break;
            }
        }

        if (recipientSocket) {
            io.to(recipientSocket).emit('receive_dm', {
                from: sender.username,
                message: sanitizeMessage(data.message),
                timestamp: new Date().toLocaleTimeString()
            });
            
            socket.emit('dm_sent', {
                to: data.recipient,
                message: data.message,
                timestamp: new Date().toLocaleTimeString()
            });
            console.log(`💌 DM from ${sender.username} to ${data.recipient}`);
        } else {
            socket.emit('error_message', '❌ User not found');
        }
    });

    // Ban user (Owner only)
    socket.on('ban_user', (data) => {
        const moderator = users.get(socket.id);
        if (moderator.rank !== 'Owner') {
            socket.emit('error_message', '❌ You do not have permission to ban users');
            return;
        }

        bannedUsers.add(data.username);
        io.emit('system_message', `🚫 ${data.username} has been banned from the chat`);
        
        // Disconnect the banned user
        for (let [socketId, user] of users) {
            if (user.username === data.username) {
                io.to(socketId).emit('error_message', '🚫 You have been banned');
                break;
            }
        }
        console.log(`🚫 ${data.username} banned by ${moderator.username}`);
    });

    // Timeout user (Owner/Mod/Admin)
    socket.on('timeout_user', (data) => {
        const moderator = users.get(socket.id);
        if (!['Owner', 'Head Admin', 'Co-Owner', 'Admin', 'Mod'].includes(moderator.rank)) {
            socket.emit('error_message', '❌ You do not have permission to timeout users');
            return;
        }

        timedOutUsers.set(data.username, true);
        io.emit('system_message', `⏱️ ${data.username} has been timed out for 1 hour`);

        // Remove timeout after 1 hour (3600000 ms)
        setTimeout(() => {
            timedOutUsers.delete(data.username);
            io.emit('system_message', `✅ ${data.username}'s timeout has expired`);
        }, 3600000);

        console.log(`⏱️ ${data.username} timed out by ${moderator.username}`);
    });

    // Warn user
    socket.on('warn_user', (data) => {
        const moderator = users.get(socket.id);
        if (!['Owner', 'Head Admin', 'Co-Owner', 'Admin', 'Mod'].includes(moderator.rank)) {
            socket.emit('error_message', '❌ You do not have permission to warn users');
            return;
        }

        const currentWarnings = userWarnings.get(data.username) || 0;
        userWarnings.set(data.username, currentWarnings + 1);
        
        io.emit('system_message', `⚠️ ${data.username} has been warned (${currentWarnings + 1}/3)`);

        // Auto-ban after 3 warnings
        if (currentWarnings + 1 >= 3) {
            bannedUsers.add(data.username);
            io.emit('system_message', `🚫 ${data.username} has been banned (3 warnings)`);
        }

        console.log(`⚠️ ${data.username} warned by ${moderator.username}`);
    });

    // Kick user
    socket.on('kick_user', (data) => {
        const moderator = users.get(socket.id);
        if (!['Owner', 'Head Admin', 'Co-Owner', 'Admin', 'Mod'].includes(moderator.rank)) {
            socket.emit('error_message', '❌ You do not have permission to kick users');
            return;
        }

        // Find and disconnect the user
        for (let [socketId, user] of users) {
            if (user.username === data.username) {
                io.to(socketId).emit('error_message', '👢 You have been kicked from the chat');
                io.sockets.sockets.get(socketId).disconnect();
                break;
            }
        }

        io.emit('system_message', `👢 ${data.username} has been kicked from the chat`);
        console.log(`👢 ${data.username} kicked by ${moderator.username}`);
    });

    // Give rank
    socket.on('give_rank', (data) => {
        const moderator = users.get(socket.id);
        if (moderator.rank !== 'Owner') {
            socket.emit('error_message', '❌ Only Owner can give ranks');
            return;
        }

        // Find user and update rank
        for (let [socketId, user] of users) {
            if (user.username === data.username) {
                user.rank = data.rank;
                
                // Send notification to the promoted user
                io.to(socketId).emit('system_message', `✨ You have been promoted to ${data.rank}`);
                break;
            }
        }

        io.emit('system_message', `✨ ${data.username} is now a ${data.rank}`);
        io.emit('users_list', Array.from(users.values()));
        console.log(`⭐ ${data.username} promoted to ${data.rank} by ${moderator.username}`);
    });

    // User disconnects
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            users.delete(socket.id);
            io.emit('user_left', {
                username: user.username,
                message: `${user.username} left the chat`,
                timestamp: new Date().toLocaleTimeString()
            });
            io.emit('users_list', Array.from(users.values()));
            console.log(`👋 ${user.username} disconnected`);
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 NotMagic Chat Server running on http://localhost:${PORT}`);
    console.log(`✨ Server ready! Open browser to http://localhost:${PORT}`);
});
