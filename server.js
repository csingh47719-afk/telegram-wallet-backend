const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
    res.send('Telegram Mining Backend is Running!');
});

app.post('/api/claim', (req, res) => {
    const { telegram_id } = req.body;
    res.json({ success: true, message: 'Claim successful!', added: 2.9270 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
