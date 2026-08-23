const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Duşuşyklary Meýilleşdirmek (API) ----
// Duşuşyklar serweriň hakydasynda (memory) saklanýar.
// Serwer gaýtadan başlansa (Render "uklap" täzeden ukusyz bolanda ýa-da deploý edilende) ýatdan çykar.
let meetings = [];

// Ähli meýilleşdirilen duşuşyklaryň sanawyny almak
app.get('/api/meetings', (req, res) => {
    res.json(meetings);
});

// Täze duşuşyk meýilleşdirmek
app.post('/api/meetings', (req, res) => {
    const { title, roomId, date, time, organizerName } = req.body || {};

    if (!title || !roomId || !date || !time) {
        return res.status(400).json({ error: 'Maglumatlar doly däl' });
    }

    const newMeeting = {
        id: Date.now().toString(),
        title,
        roomId,
        date,
        time,
        organizerName: organizerName || 'Näbelli'
    };

    meetings.push(newMeeting);
    res.status(201).json(newMeeting);
});

// Otaglaryň içindäki ulanyjylary ýatda saklamak: { roomId: { socketId: { name, audio, video } } }
const rooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUserName = null;

    // Ulanyjy otaga girende
    socket.on('join-room', ({ roomId, userName }) => {
        currentRoom = roomId;
        currentUserName = userName;

        socket.join(roomId);

        if (!rooms[roomId]) rooms[roomId] = {};

        // Otagda öňden bar bolan ulanyjylaryň sanawyny (at + ses/wideo ýagdaýy) täze goşulan adama ibermek
        const existingUsers = Object.entries(rooms[roomId]).map(([id, info]) => ({
            id, name: info.name, audio: info.audio, video: info.video
        }));
        socket.emit('existing-users', existingUsers);

        // Täze ulanyjyny otagdaky beýlekilere habar bermek (başlangyçda mikrofon/kamera açyk hasaplanýar)
        rooms[roomId][socket.id] = { name: userName, audio: true, video: true };
        socket.to(roomId).emit('user-joined', { id: socket.id, name: userName, audio: true, video: true });
    });

    // WebRTC signal alyş-çalyşy (offer / answer / ice-candidate)
    socket.on('offer', ({ to, offer }) => {
        io.to(to).emit('offer', { from: socket.id, offer });
    });

    socket.on('answer', ({ to, answer }) => {
        io.to(to).emit('answer', { from: socket.id, answer });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
        io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    });

    // Çat hatlary
    socket.on('chat-message', ({ text }) => {
        if (!currentRoom) return;
        io.to(currentRoom).emit('chat-message', {
            senderId: socket.id,
            senderName: currentUserName,
            text
        });
    });

    // Eliňi götermek
    socket.on('raise-hand', ({ raised }) => {
        if (!currentRoom) return;
        socket.to(currentRoom).emit('raise-hand', { id: socket.id, raised });
    });

    // Kamera/mikrofon ýagdaýyny beýlekilere habar bermek (we otagyň ýadynda-da täzelemek)
    socket.on('media-state', ({ audio, video }) => {
        if (!currentRoom) return;
        if (rooms[currentRoom] && rooms[currentRoom][socket.id]) {
            rooms[currentRoom][socket.id].audio = audio;
            rooms[currentRoom][socket.id].video = video;
        }
        socket.to(currentRoom).emit('media-state', { id: socket.id, audio, video });
    });

    // Ulanyjy çykanda ýa-da baglanyşyk üzülende
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom][socket.id];
            socket.to(currentRoom).emit('user-left', { id: socket.id });

            if (Object.keys(rooms[currentRoom]).length === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer işleýär: http://localhost:${PORT}`);
});
