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

app.use(express.static('public'));

// Banned words for auto-moderation
const bannedWords = ['badword1', 'badword2', 'inappropriate', 'spam', 'nsfw'];
const users = new Map(); // Store user info
const bannedUsers = new Set();
const timedOutUsers = new Map();

// Sanitize messages
function sanitizeMessage(text) {
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
        if (bannedUsers.has(username)) {
            socket.emit('error_message', 'You are banned from this chat.');
            socket.disconnect();
            return;
        }

        users.set(socket.id, {
            username: username,
            rank: 'User',
            socketId: socket.id
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

        // Check if user is timed out
        if (timedOutUsers.has(user.username)) {
            socket.emit('error_message', 'You are timed out');
            return;
        }

        const sanitized = sanitizeMessage(data.message);
        
        // Broadcast message to all users
        io.emit('chat_message', {
            username: user.username,
            rank: user.rank,
            message: sanitized,
            timestamp: new Date().toLocaleTimeString(),
            image: data.image || null
        });

        console.log(`💬 ${user.username}: ${sanitized}`);
    });

    // Direct Message
    socket.on('send_dm', (data) => {
        const sender = users.get(socket.id);
        if (!sender) return;

        // Find recipient
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
                message: data.message,
                timestamp: new Date().toLocaleTimeString()
            });
            socket.emit('dm_sent', {
                to: data.recipient,
                message: data.message,
                timestamp: new Date().toLocaleTimeString()
            });
        } else {
            socket.emit('error_message', 'User not found');
        }
    });

    // Ban user (Owner only)
    socket.on('ban_user', (data) => {
        const moderator = users.get(socket.id);
        if (moderator.rank !== 'Owner') {
            socket.emit('error_message', 'You do not have permission');
            return;
        }

        bannedUsers.add(data.username);
        io.emit('system_message', `${data.username} has been banned`);
        console.log(`🚫 ${data.username} banned`);
    });

    // Timeout user (Owner/Mod)
    socket.on('timeout_user', (data) => {
        const moderator = users.get(socket.id);
        if (!['Owner', 'Head Admin', 'Co-Owner', 'Admin', 'Mod'].includes(moderator.rank)) {
            socket.emit('error_message', 'You do not have permission');
            return;
        }

        timedOutUsers.set(data.username, true);
        io.emit('system_message', `${data.username} has been timed out for 1 hour`);

        // Remove timeout after 1 hour
        setTimeout(() => {
            timedOutUsers.delete(data.username);
        }, 3600000);

        console.log(`⏱️ ${data.username} timed out`);
    });

    // Give rank
    socket.on('give_rank', (data) => {
        const moderator = users.get(socket.id);
        if (moderator.rank !== 'Owner') {
            socket.emit('error_message', 'Only Owner can give ranks');
            return;
        }

        // Find user and update rank
        for (let [socketId, user] of users) {
            if (user.username === data.username) {
                user.rank = data.rank;
                break;
            }
        }

        io.emit('system_message', `${data.username} is now a ${data.rank}`);
        io.emit('users_list', Array.from(users.values()));
        console.log(`⭐ ${data.username} promoted to ${data.rank}`);
    });

    // Warn user
    socket.on('warn_user', (data) => {
        const moderator = users.get(socket.id);
        if (!['Owner', 'Head Admin', 'Co-Owner', 'Admin', 'Mod'].includes(moderator.rank)) {
            return;
        }

        io.emit('system_message', `${data.username} has been warned`);
    });

    // Typing indicator
    socket.on('user_typing', (data) => {
        const user = users.get(socket.id);
        if (user) {
            socket.broadcast.emit('user_typing', {
                username: user.username
            });
        }
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

server.listen(3000, () => {
    console.log('🚀 NotMagic Chat Server running on http://localhost:3000');
});
