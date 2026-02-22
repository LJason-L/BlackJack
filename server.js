const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let rooms = {}; 
let roomTimers = {}; 
const suits = ['♠', '♥', '♦', '♣'];

function generateRoomId() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 4; i++) result += characters.charAt(Math.floor(Math.random() * characters.length));
    return result;
}

function calculateScore(cards) {
    if(!cards) return 0;
    let score = 0, aces = 0;
    for (let c of cards) {
        if (c.hidden) continue;
        if (c.value === 1) { aces += 1; score += 11; }
        else if (c.value > 10) { score += 10; }
        else { score += c.value; }
    }
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

function calculateScoreString(cards) {
    if(!cards || cards.length === 0) return "0";
    let sum = 0, aces = 0;
    for (let c of cards) {
        if (c.hidden) continue;
        if (c.value === 1) { aces += 1; sum += 1; }
        else if (c.value > 10) { sum += 10; }
        else { sum += c.value; }
    }
    if (aces === 0) return sum.toString();
    
    let maxScore = sum + 10; 
    if (maxScore > 21) return sum.toString(); 
    if (maxScore === 21) return "21"; 
    return `${sum}/${maxScore}`; 
}

function createInitialGameState() {
    return {
        status: 'waiting', 
        numberOfDecks: 8, 
        deck: [],
        dealerId: null, 
        hostId: null,   
        seats: [null, null, null, null, null], 
        dealerCards: [],
        dealerScore: 0,
        dealerState: 'waiting', 
        players: {}, 
        offlinePlayers: [], 
        chipRequests: [], 
        currentSeatIndex: -1,
        timer: 0,
        timerType: '', 
        message: "等待玩家入座與申請籌碼...",
        messageColor: "#F5D061"
    };
}

function initDeck(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    state.deck = [];
    for (let i = 0; i < state.numberOfDecks; i++) { 
        for (let s of suits) {
            for (let v = 1; v <= 13; v++) state.deck.push({ suit: s, value: v, isNew: false });
        }
    }
    for (let i = state.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.deck[i], state.deck[j]] = [state.deck[j], state.deck[i]];
    }
}

function drawCard(roomId, faceDown = false) {
    let state = rooms[roomId];
    if(!state || !state.deck || state.deck.length === 0) return null;
    let card = state.deck.pop();
    card.faceDown = faceDown;
    card.isNew = true; 
    return card;
}

function sendSanitizedState(roomId) {
    let state = rooms[roomId];
    if (!state) return;
    io.in(roomId).fetchSockets().then(sockets => {
        sockets.forEach(socket => {
            try {
                let s = JSON.parse(JSON.stringify(state)); 
                s.seats.forEach(seat => {
                    if (seat && seat.cards) {
                        seat.score = calculateScore(seat.cards); 
                        seat.scoreDisplay = calculateScoreString(seat.cards.filter(c => !c.hidden));
                    }
                });
                if (s.status !== 'dealer_turn' && s.status !== 'settled') {
                    if(s.dealerCards) {
                        s.dealerCards = s.dealerCards.map(c => {
                            if (c.faceDown) {
                                if (s.dealerId === socket.id) return { ...c, faceDown: false }; 
                                else return { hidden: true, isNew: c.isNew };
                            }
                            return c;
                        });
                        let visibleCards = s.dealerCards.filter(c => !c.hidden);
                        s.dealerScore = calculateScore(visibleCards);
                        s.dealerScoreDisplay = calculateScoreString(visibleCards);
                    }
                } else {
                    s.dealerScore = calculateScore(s.dealerCards);
                    s.dealerScoreDisplay = calculateScoreString(s.dealerCards);
                }
                socket.emit('update_state', s);
            } catch(e) {}
        });
    });
}

function clearNewFlags(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    state.seats.forEach(seat => { if(seat && seat.cards) seat.cards.forEach(c => c.isNew = false); });
    if(state.dealerCards) state.dealerCards.forEach(c => c.isNew = false);
}

function autoClearAnimation(roomId, delay) {
    setTimeout(() => {
        try {
            if(!rooms[roomId]) return;
            clearNewFlags(roomId);
            sendSanitizedState(roomId);
        } catch(e){}
    }, delay);
}

function startBetting(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    if (state.deck.length < 50) {
        state.message = "🃏 牌庫即將見底，更換 8 副新牌中...";
        state.messageColor = "#F5D061";
        io.to(roomId).emit('shuffling_deck');
        initDeck(roomId);
        setTimeout(() => executeStartBetting(roomId), 3000);
    } else {
        executeStartBetting(roomId);
    }
}

function executeStartBetting(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    state.status = 'betting';
    state.timer = 10;
    state.timerType = 'betting';
    state.dealerCards = [];
    state.dealerScore = 0;
    state.dealerState = 'waiting';
    
    let someoneSitting = false;
    state.seats.forEach(seat => {
        if(seat) {
            seat.cards = [];
            seat.score = 0;
            seat.bet = 0;
            seat.insurance = 0; 
            seat.betBehind = {};
            seat.state = 'betting'; 
            seat.handPnl = 0;
            seat.isBetConfirmed = false;
            seat.isDoubleDown = false;
            someoneSitting = true;
        }
    });

    if(!someoneSitting) {
        state.status = 'waiting';
        state.message = "無人入座，無法開局！";
        sendSanitizedState(roomId);
        return;
    }

    state.message = "⏳ 倒數 10 秒！請點擊發光的座位或買馬區下注...";
    sendSanitizedState(roomId);

    if(roomTimers[roomId]) clearInterval(roomTimers[roomId]);
    roomTimers[roomId] = setInterval(() => {
        try {
            let st = rooms[roomId];
            if(!st) { clearInterval(roomTimers[roomId]); return; }
            st.timer--;
            io.to(roomId).emit('timer_tick', { time: st.timer, type: 'betting' });
            if (st.timer <= 0) {
                clearInterval(roomTimers[roomId]);
                dealInitialCards(roomId);
            }
        } catch(e){ clearInterval(roomTimers[roomId]); }
    }, 1000);
}

function dealInitialCards(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    state.status = 'dealing';
    
    let activeSeats = [];
    state.seats.forEach((seat, index) => {
        if (seat) {
            if (seat.bet > 0 || Object.keys(seat.betBehind).some(k => seat.betBehind[k].amount > 0)) {
                activeSeats.push(index);
                seat.state = 'playing';
            } else {
                seat.state = 'waiting_next'; 
            }
        }
    });

    if(activeSeats.length === 0) {
        state.status = 'waiting';
        state.message = "本局無人下注，已流局。";
        sendSanitizedState(roomId);
        return;
    }

    let queue = [];
    let sortedSeats = activeSeats.slice().sort((a,b) => b - a); 
    sortedSeats.forEach(idx => queue.push({ target: 'player', idx: idx, faceDown: false })); 
    queue.push({ target: 'dealer', faceDown: false }); 
    sortedSeats.forEach(idx => queue.push({ target: 'player', idx: idx, faceDown: false })); 
    queue.push({ target: 'dealer', faceDown: true }); 

    let delay = 0;
    queue.forEach((task) => {
        setTimeout(() => {
            try {
                let st = rooms[roomId];
                if(!st) return;
                clearNewFlags(roomId);
                let card = drawCard(roomId, task.faceDown);
                if(card) {
                    if (task.target === 'player' && st.seats[task.idx]) st.seats[task.idx].cards.push(card);
                    else st.dealerCards.push(card);
                    io.to(roomId).emit('play_card_sfx');
                    sendSanitizedState(roomId);
                }
            } catch(e){}
        }, delay);
        delay += 600; 
    });

    setTimeout(() => {
        try {
            let st = rooms[roomId];
            if(!st) return;
            clearNewFlags(roomId);
            
            activeSeats.forEach(idx => {
                let seat = st.seats[idx];
                if(seat) {
                    seat.score = calculateScore(seat.cards);
                    if (seat.score === 21) {
                        seat.state = 'blackjack';
                        io.to(roomId).emit('player_blackjack', idx); 
                    }
                }
            });
            autoClearAnimation(roomId, 1000); 

            if (st.dealerCards[0] && st.dealerCards[0].value === 1) {
                triggerInsurance(roomId);
            } else {
                st.status = 'playing';
                st.currentSeatIndex = 5; 
                nextPlayerTurn(roomId);
            }
        } catch(e){}
    }, delay + 500);
}

function triggerInsurance(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    state.status = 'insurance';
    state.timer = 10;
    state.timerType = 'action';
    state.message = "🛡️ 莊家明牌為 A！是否購買保險 (10秒)？";
    sendSanitizedState(roomId);

    if(roomTimers[roomId]) clearInterval(roomTimers[roomId]);
    roomTimers[roomId] = setInterval(() => {
        try {
            let st = rooms[roomId];
            if(!st) { clearInterval(roomTimers[roomId]); return; }
            st.timer--;
            io.to(roomId).emit('timer_tick', { time: st.timer, type: 'action' });
            if (st.timer <= 0) {
                clearInterval(roomTimers[roomId]);
                resolveInsurance(roomId);
            }
        }catch(e){ clearInterval(roomTimers[roomId]); }
    }, 1000);
}

function resolveInsurance(roomId) {
    let state = rooms[roomId];
    if(!state || !state.dealerCards[1]) return;
    let dealerHiddenCard = state.dealerCards[1];
    let isDealerBJ = (dealerHiddenCard.value === 1 || dealerHiddenCard.value >= 10); 

    if (isDealerBJ) {
        state.message = "💥 莊家是 BLACKJACK！保險理賠 2 倍！";
        state.dealerCards[1].faceDown = false; 
        sendSanitizedState(roomId);
        setTimeout(() => settleGame(roomId), 2500);
    } else {
        state.message = "❌ 莊家不是 BLACKJACK，保險金沒收！遊戲繼續。";
        sendSanitizedState(roomId);
        setTimeout(() => {
            if(!rooms[roomId]) return;
            rooms[roomId].status = 'playing';
            rooms[roomId].currentSeatIndex = 5;
            nextPlayerTurn(roomId);
        }, 2000);
    }
}

function nextPlayerTurn(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    if(roomTimers[roomId]) clearInterval(roomTimers[roomId]);

    state.currentSeatIndex--;
    while (state.currentSeatIndex >= 0) {
        let seat = state.seats[state.currentSeatIndex];
        if (seat && seat.state === 'playing') {
            let pOwner = state.players[seat.ownerId] || state.offlinePlayers.find(p => p.oldId === seat.ownerId);
            let ownerName = pOwner ? pOwner.name : "玩家";
            
            state.message = `👉 等待【${ownerName}】決策...`;
            state.timer = 10;
            state.timerType = 'action';
            sendSanitizedState(roomId);

            roomTimers[roomId] = setInterval(() => {
                try {
                    let st = rooms[roomId];
                    if(!st) { clearInterval(roomTimers[roomId]); return; }
                    st.timer--;
                    io.to(roomId).emit('timer_tick', { time: st.timer, type: 'action' });
                    if (st.timer <= 0) {
                        clearInterval(roomTimers[roomId]);
                        if(st.seats[st.currentSeatIndex]) st.seats[st.currentSeatIndex].state = 'stood'; 
                        nextPlayerTurn(roomId);
                    }
                }catch(e){ clearInterval(roomTimers[roomId]); }
            }, 1000);
            return;
        }
        state.currentSeatIndex--;
    }
    dealerTurn(roomId);
}

function dealerTurn(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    state.status = 'dealer_turn';

    if(state.dealerCards.length >= 2) {
        state.dealerCards[1].faceDown = false; 
        state.dealerCards[1].isNew = true; 
    }
    state.dealerScore = calculateScore(state.dealerCards);
    
    state.message = "🎭 莊家翻開暗牌！";
    sendSanitizedState(roomId);
    autoClearAnimation(roomId, 1000);

    let needsToDraw = false;
    state.seats.forEach(seat => {
        if (seat && seat.state === 'stood') needsToDraw = true; 
    });

    setTimeout(() => {
        try {
            let st = rooms[roomId];
            if(!st) return;
            if (!needsToDraw || st.dealerScore >= 17) {
                if (st.dealerScore > 21) st.dealerState = 'bust';
                else st.dealerState = 'stood';
                st.message = `🛑 莊家 ${st.dealerScore} 點。進入結算！`;
                sendSanitizedState(roomId);
                setTimeout(() => settleGame(roomId), 1500);
                return;
            }

            let drawInterval = setInterval(() => {
                try {
                    let s = rooms[roomId];
                    if(!s) { clearInterval(drawInterval); return; }
                    clearNewFlags(roomId);
                    if (s.dealerScore < 17) {
                        s.message = `莊家 ${s.dealerScore} 點，低於 17 必須補牌！`;
                        let card = drawCard(roomId, false);
                        if(card) s.dealerCards.push(card);
                        s.dealerScore = calculateScore(s.dealerCards);
                        io.to(roomId).emit('play_card_sfx');
                        sendSanitizedState(roomId);
                        autoClearAnimation(roomId, 800);
                    } else {
                        clearInterval(drawInterval);
                        if (s.dealerScore > 21) {
                            s.dealerState = 'bust';
                            s.message = "💥 莊家爆牌！";
                            s.messageColor = "#FF3366";
                        } else {
                            s.dealerState = 'stood';
                            s.message = `🛑 莊家 ${s.dealerScore} 點停牌。`;
                            s.messageColor = "#00E676";
                        }
                        sendSanitizedState(roomId);
                        setTimeout(() => settleGame(roomId), 2000);
                    }
                }catch(e){ clearInterval(drawInterval); }
            }, 1200); 
        }catch(e){}
    }, 1500);
}

// 🛡️ 史詩級修復：無敵鐵血判定系統 🛡️
function settleGame(roomId) {
    let state = rooms[roomId];
    if(!state) return;
    state.status = 'settled';
    
    // 重新計算確保點數絕對精準
    state.dealerScore = calculateScore(state.dealerCards);
    let dScore = state.dealerScore > 21 ? 0 : state.dealerScore; // 莊家爆牌算 0 點
    let dIsBJ = (state.dealerCards.length === 2 && state.dealerScore === 21);

    let handResults = []; 
    let playerHandTotalPnL = {};
    for(let id in state.players) playerHandTotalPnL[id] = 0;
    state.offlinePlayers.forEach(p => playerHandTotalPnL[p.oldId] = 0);

    state.seats.forEach((seat, idx) => {
        if (!seat || seat.state === 'waiting_next' || (seat.bet === 0 && Object.keys(seat.betBehind).length === 0)) return;

        seat.score = calculateScore(seat.cards);
        let pScore = seat.score;
        let pIsBJ = (seat.cards.length === 2 && pScore === 21);
        let multiplier = 0; 

        // 🎲 嚴格實體賭場判定規則 🎲
        if (pScore > 21) { 
            // 規則1: 玩家爆牌，不管莊家幾點，玩家一定輸 (直接扣錢)
            multiplier = -1; 
        } else if (pIsBJ && dIsBJ) {
            // 規則2: 雙方都是 BJ -> 平手退注
            multiplier = 0; 
        } else if (pIsBJ && !dIsBJ) {
            // 規則3: 只有玩家 BJ -> 賠 1.5 倍
            multiplier = 1.5; 
        } else if (!pIsBJ && dIsBJ) {
            // 規則4: 只有莊家 BJ -> 玩家全輸
            multiplier = -1; 
        } else if (state.dealerScore > 21) {
            // 規則5: 莊家爆牌 (且玩家沒爆) -> 玩家贏 1 倍
            multiplier = 1;
        } else {
            // 規則6: 都沒爆牌，沒 BJ，單純比大小
            if (pScore > dScore) multiplier = 1;
            else if (pScore < dScore) multiplier = -1;
            else multiplier = 0;
        }

        let owner = state.players[seat.ownerId] || state.offlinePlayers.find(p => p.oldId === seat.ownerId);
        let dealer = state.players[state.dealerId] || state.offlinePlayers.find(p => p.oldId === state.dealerId);
        
        let seatTotalPnL = 0;
        
        // 結算保險
        if (seat.insurance > 0) {
            let insResult = dIsBJ ? (seat.insurance * 2) : -seat.insurance;
            if (owner) { owner.balance += (dIsBJ ? (seat.insurance + insResult) : 0); owner.pnl += insResult; playerHandTotalPnL[owner.oldId || seat.ownerId] += insResult;}
            if (dealer) { dealer.balance -= insResult; dealer.pnl -= insResult; playerHandTotalPnL[dealer.oldId || state.dealerId] -= insResult; }
        }

        // 結算主位
        if (seat.bet > 0) {
            let pnlChange = seat.bet * multiplier;
            seatTotalPnL += pnlChange;
            if (owner) {
                owner.balance += (seat.bet + pnlChange); 
                owner.pnl += pnlChange;
                playerHandTotalPnL[owner.oldId || seat.ownerId] += pnlChange;
            }
            if (dealer) {
                dealer.balance -= pnlChange;
                dealer.pnl -= pnlChange;
                playerHandTotalPnL[dealer.oldId || state.dealerId] -= pnlChange;
            }
            seat.state = multiplier > 0 ? 'won' : (multiplier < 0 ? 'lost' : 'push');
            handResults.push({ seatIndex: idx, result: seat.state, amount: seatTotalPnL });
        } else {
            seat.state = 'push';
        }

        // 結算買馬
        for (let specId in seat.betBehind) {
            let spec = state.players[specId] || state.offlinePlayers.find(p => p.oldId === specId);
            let specBetObj = seat.betBehind[specId] || { amount: 0, insurance: 0 };
            let specBet = specBetObj.amount || 0;
            let specIns = specBetObj.insurance || 0;
            
            if (specIns > 0) {
                let sInsRes = dIsBJ ? (specIns * 2) : -specIns;
                if(spec) { spec.balance += (dIsBJ ? (specIns + sInsRes) : 0); spec.pnl += sInsRes; playerHandTotalPnL[spec.oldId || specId] += sInsRes; }
                if(dealer) { dealer.balance -= sInsRes; dealer.pnl -= sInsRes; playerHandTotalPnL[dealer.oldId || state.dealerId] -= sInsRes; }
            }

            if (specBet > 0) {
                let specChange = specBet * multiplier;
                if(spec) {
                    spec.balance += (specBet + specChange);
                    spec.pnl += specChange;
                    playerHandTotalPnL[spec.oldId || specId] += specChange;
                }
                if(dealer) {
                    dealer.balance -= specChange;
                    dealer.pnl -= specChange;
                    playerHandTotalPnL[dealer.oldId || state.dealerId] -= specChange;
                }
            }
        }
    });

    state.message = "🏆 單局結算完成！";
    sendSanitizedState(roomId);
    io.to(roomId).emit('hand_settled_animation', { results: handResults, playerHandTotalPnL });
}

function safe(fn) { return function(...args) { try { fn(...args); } catch(e) { console.error("Caught Safe Error:", e); } } }

io.on('connection', (socket) => {
    socket.on('create_room', safe((playerName) => {
        let roomId = generateRoomId();
        socket.join(roomId);
        socket.roomId = roomId; 
        rooms[roomId] = createInitialGameState();
        let state = rooms[roomId];
        state.dealerId = socket.id; 
        state.hostId = socket.id; 
        state.players[socket.id] = { name: playerName, pnl: 0, balance: 100000 }; 
        initDeck(roomId);
        socket.emit('room_joined', roomId); 
        sendSanitizedState(roomId);
    }));

    socket.on('join_room', safe((data) => {
        let { playerName, roomId } = data;
        roomId = roomId.toUpperCase();
        if (!rooms[roomId]) return socket.emit('error_msg', "房號錯誤！");
        let state = rooms[roomId];
        
        let isOnline = Object.values(state.players).some(p => p.name === playerName);
        if (isOnline) return socket.emit('error_msg', "包廂內已有同名玩家！");

        socket.join(roomId);
        socket.roomId = roomId;

        let offlineIdx = state.offlinePlayers.findIndex(p => p.name === playerName);
        if (offlineIdx !== -1) {
            let restoredPlayer = state.offlinePlayers.splice(offlineIdx, 1)[0];
            let oldId = restoredPlayer.oldId;
            state.players[socket.id] = restoredPlayer;
            
            if (state.dealerId === oldId) state.dealerId = socket.id;
            if (state.hostId === oldId) state.hostId = socket.id;

            state.seats.forEach(seat => {
                if (seat && seat.ownerId === oldId) seat.ownerId = socket.id;
                if (seat && seat.betBehind && seat.betBehind[oldId] !== undefined) {
                    seat.betBehind[socket.id] = seat.betBehind[oldId];
                    delete seat.betBehind[oldId];
                }
            });
            state.chipRequests.forEach(req => { if (req.id === oldId) req.id = socket.id; });
            state.message = `🔥 ${playerName} 重新連線回到賭局！`;
        } else {
            state.players[socket.id] = { name: playerName, pnl: 0, balance: 0 };
            state.message = `👋 ${playerName} 進入了包廂。`;
        }
        socket.emit('room_joined', roomId);
        sendSanitizedState(roomId);
    }));

    socket.on('apply_chips', safe((amount) => {
        let state = rooms[socket.roomId];
        if (state && state.players[socket.id]) {
            state.chipRequests.push({ id: socket.id, name: state.players[socket.id].name, amount: amount });
            sendSanitizedState(socket.roomId);
        }
    }));

    socket.on('approve_chips', safe((data) => {
        let state = rooms[socket.roomId];
        if (state && state.dealerId === socket.id) {
            let reqIdx = state.chipRequests.findIndex(r => r.id === data.playerId && r.amount === data.amount);
            if (reqIdx !== -1) {
                state.chipRequests.splice(reqIdx, 1);
                if (state.players[data.playerId]) state.players[data.playerId].balance += data.amount;
                sendSanitizedState(socket.roomId);
            }
        }
    }));

    socket.on('reject_chips', safe((data) => {
        let state = rooms[socket.roomId];
        if (state && state.dealerId === socket.id) {
            state.chipRequests = state.chipRequests.filter(r => !(r.id === data.playerId && r.amount === data.amount));
            sendSanitizedState(socket.roomId);
        }
    }));

    socket.on('take_seat', safe((seatIndex) => {
        let state = rooms[socket.roomId];
        if (!state || state.status === 'dealing' || state.status === 'dealer_turn') return;
        if (state.seats[seatIndex] !== null || socket.id === state.dealerId) return; 
        if (!state.players[socket.id]) return;
        if (state.players[socket.id].balance <= 0) return socket.emit('error_msg', "餘額為 $0，請先向莊家申請籌碼！");

        state.seats[seatIndex] = {
            ownerId: socket.id, bet: 0, insurance: 0, cards: [], score: 0,
            state: state.status === 'playing' ? 'waiting_next' : 'waiting', 
            betBehind: {}, handPnl: 0, isBetConfirmed: false, isDoubleDown: false
        };
        sendSanitizedState(socket.roomId);
    }));

    socket.on('leave_seat', safe((seatIndex) => {
        let state = rooms[socket.roomId];
        if (!state) return;
        let seat = state.seats[seatIndex];
        if (seat && seat.ownerId === socket.id && (state.status === 'waiting' || state.status === 'settled')) {
            if(state.players[socket.id]) state.players[socket.id].balance += seat.bet;
            if(seat.betBehind) {
                for(let specId in seat.betBehind) {
                    let spec = state.players[specId] || state.offlinePlayers.find(p => p.oldId === specId);
                    if(spec && seat.betBehind[specId]) spec.balance += (seat.betBehind[specId].amount || 0);
                }
            }
            state.seats[seatIndex] = null;
            sendSanitizedState(socket.roomId);
        }
    }));

    socket.on('start_betting', safe(() => {
        let state = rooms[socket.roomId];
        if (state && state.dealerId === socket.id) startBetting(socket.roomId);
    }));

    socket.on('add_bet', safe((data) => {
        let state = rooms[socket.roomId];
        if (state && state.status === 'betting') {
            let seat = state.seats[data.seatIndex];
            let player = state.players[socket.id];
            if (!player || !seat) return;

            if (data.type === 'main' && seat.ownerId === socket.id) {
                if (seat.isBetConfirmed) return;
                if (player.balance >= data.amount) {
                    player.balance -= data.amount;
                    seat.bet += data.amount;
                } else socket.emit('error_msg', "餘額不足！");
            } else if (data.type === 'behind' && seat.ownerId !== socket.id) {
                if (seat.bet === 0) return socket.emit('error_msg', "主位玩家尚未下注，無法買馬！");
                
                if(!seat.betBehind[socket.id]) seat.betBehind[socket.id] = { amount: 0, insurance: 0, isConfirmed: false };
                if (seat.betBehind[socket.id].isConfirmed) return;
                
                if (player.balance >= data.amount) {
                    player.balance -= data.amount;
                    seat.betBehind[socket.id].amount += data.amount;
                } else socket.emit('error_msg', "買馬餘額不足！");
            }
            sendSanitizedState(socket.roomId);
        }
    }));

    socket.on('clear_bet', safe((data) => {
        let state = rooms[socket.roomId];
        if (state && state.status === 'betting') {
            let seat = state.seats[data.seatIndex];
            let player = state.players[socket.id];
            if (!player || !seat) return;

            if (data.type === 'main' && seat.ownerId === socket.id) {
                if(seat.isBetConfirmed) return;
                player.balance += seat.bet;
                seat.bet = 0;
            } else if (data.type === 'behind' && seat.ownerId !== socket.id && seat.betBehind[socket.id]) {
                if(seat.betBehind[socket.id].isConfirmed) return;
                player.balance += seat.betBehind[socket.id].amount;
                delete seat.betBehind[socket.id];
            }
            sendSanitizedState(socket.roomId);
        }
    }));

    socket.on('confirm_bet', safe((data) => {
        let state = rooms[socket.roomId];
        if (state && state.status === 'betting') {
            let seat = state.seats[data.seatIndex];
            if(!seat) return;
            if (data.type === 'main' && seat.ownerId === socket.id) {
                seat.isBetConfirmed = true;
            } else if (data.type === 'behind' && seat.betBehind[socket.id]) {
                seat.betBehind[socket.id].isConfirmed = true;
            }
            sendSanitizedState(socket.roomId);
        }
    }));

    socket.on('buy_insurance', safe((data) => {
        let state = rooms[socket.roomId];
        if (state && state.status === 'insurance') {
            let player = state.players[socket.id];
            if(!player) return;

            if(data.type === 'main') {
                let seat = state.seats[data.seatIndex];
                if(seat && seat.ownerId === socket.id && seat.insurance === 0 && seat.bet > 0) {
                    let insAmt = Math.floor(seat.bet / 2);
                    if(player.balance >= insAmt) {
                        player.balance -= insAmt;
                        seat.insurance = insAmt;
                        sendSanitizedState(socket.roomId);
                    } else socket.emit('error_msg', "餘額不足購買保險！");
                }
            } else if(data.type === 'behind') {
                let seat = state.seats[data.seatIndex];
                if(seat && seat.betBehind[socket.id] && seat.betBehind[socket.id].insurance === 0 && seat.betBehind[socket.id].amount > 0) {
                    let insAmt = Math.floor(seat.betBehind[socket.id].amount / 2);
                    if(player.balance >= insAmt) {
                        player.balance -= insAmt;
                        seat.betBehind[socket.id].insurance = insAmt;
                        sendSanitizedState(socket.roomId);
                    } else socket.emit('error_msg', "餘額不足購買保險！");
                }
            }
        }
    }));

    socket.on('hit', safe((seatIndex) => {
        let roomId = socket.roomId;
        let state = rooms[roomId];
        if (state && state.status === 'playing' && state.currentSeatIndex === seatIndex) {
            let seat = state.seats[seatIndex];
            if(!seat || seat.ownerId !== socket.id) return;
            
            if(roomTimers[roomId]) clearInterval(roomTimers[roomId]);

            clearNewFlags(roomId);
            let card = drawCard(roomId, false);
            if(card) seat.cards.push(card);
            seat.score = calculateScore(seat.cards);
            io.to(roomId).emit('play_card_sfx');

            if (seat.score > 21) {
                seat.state = 'bust';
                io.to(roomId).emit('player_bust', seatIndex);
                sendSanitizedState(roomId);
                setTimeout(() => nextPlayerTurn(roomId), 1500);
            } else if (seat.score === 21) {
                seat.state = 'stood';
                sendSanitizedState(roomId);
                setTimeout(() => nextPlayerTurn(roomId), 1000);
            } else {
                sendSanitizedState(roomId);
                autoClearAnimation(roomId, 800); 
                state.timer = 10;
                roomTimers[roomId] = setInterval(() => {
                    let st = rooms[roomId];
                    if(!st) { clearInterval(roomTimers[roomId]); return; }
                    st.timer--;
                    io.to(roomId).emit('timer_tick', { time: st.timer, type: 'action' });
                    if (st.timer <= 0) {
                        clearInterval(roomTimers[roomId]);
                        if(st.seats[seatIndex]) st.seats[seatIndex].state = 'stood';
                        nextPlayerTurn(roomId);
                    }
                }, 1000);
            }
        }
    }));

    socket.on('double_down', safe((seatIndex) => {
        let roomId = socket.roomId;
        let state = rooms[roomId];
        if (state && state.status === 'playing' && state.currentSeatIndex === seatIndex) {
            let seat = state.seats[seatIndex];
            let player = state.players[socket.id];
            if(!seat || !player || seat.ownerId !== socket.id || seat.cards.length !== 2) return; 

            if (player.balance >= seat.bet) {
                if(roomTimers[roomId]) clearInterval(roomTimers[roomId]);
                
                player.balance -= seat.bet;
                seat.bet *= 2; 
                seat.isDoubleDown = true; 
                
                clearNewFlags(roomId);
                let card = drawCard(roomId, false);
                if(card) seat.cards.push(card); 
                seat.score = calculateScore(seat.cards);
                
                io.to(roomId).emit('player_double_down', seatIndex);
                io.to(roomId).emit('play_card_sfx');

                if (seat.score > 21) {
                    seat.state = 'bust';
                    setTimeout(() => { io.to(roomId).emit('player_bust', seatIndex); }, 800);
                } else {
                    seat.state = 'stood'; 
                }
                
                sendSanitizedState(roomId);
                setTimeout(() => nextPlayerTurn(roomId), 2000);
            } else {
                socket.emit('error_msg', "餘額不足以雙倍下注！");
            }
        }
    }));

    socket.on('stand', safe((seatIndex) => {
        let state = rooms[socket.roomId];
        if (state && state.status === 'playing' && state.currentSeatIndex === seatIndex) {
            if (state.seats[seatIndex] && state.seats[seatIndex].ownerId === socket.id) {
                state.seats[seatIndex].state = 'stood';
                nextPlayerTurn(socket.roomId);
            }
        }
    }));

    socket.on('force_reset', safe(() => {
        let roomId = socket.roomId;
        let state = rooms[roomId];
        if (state && state.hostId === socket.id) {
            if(roomTimers[roomId]) clearInterval(roomTimers[roomId]);
            state.status = 'waiting';
            state.dealerCards = [];
            state.dealerScore = 0;
            state.seats.forEach(seat => {
                if(seat) {
                    seat.cards = [];
                    seat.bet = 0;
                    seat.score = 0;
                    seat.state = 'waiting';
                    seat.betBehind = {};
                    seat.isBetConfirmed = false;
                    seat.isDoubleDown = false;
                }
            });
            state.message = "🛑 室長已強制重置牌桌。";
            initDeck(roomId);
            sendSanitizedState(roomId);
        }
    }));

    socket.on('end_session', safe(() => {
        let roomId = socket.roomId;
        let state = rooms[roomId];
        if (state && state.hostId === socket.id && (state.status === 'settled' || state.status === 'waiting')) {
            state.status = 'session_ended';
            sendSanitizedState(roomId);
        }
    }));

    socket.on('change_dealer', safe((newDealerId) => {
        let roomId = socket.roomId;
        let state = rooms[roomId];
        if (state && state.hostId === socket.id && state.status === 'session_ended') {
            let newDealer = state.players[newDealerId] || state.offlinePlayers.find(p => p.oldId === newDealerId);
            if (newDealer) {
                state.dealerId = newDealer.oldId || newDealerId;
                state.seats = [null, null, null, null, null];
                
                for(let id in state.players) {
                    state.players[id].pnl = 0;
                    state.players[id].balance = (id === state.dealerId) ? 100000 : 0; 
                }
                state.offlinePlayers.forEach(p => {
                    p.pnl = 0;
                    p.balance = (p.oldId === state.dealerId) ? 100000 : 0;
                });

                state.status = 'waiting';
                state.dealerCards = [];
                state.dealerScore = 0;
                state.dealerState = 'waiting';
                state.chipRequests = [];
                state.message = `👑 莊家已移交給 ${newDealer.name}！舊局已清空。`;
                initDeck(roomId);
                sendSanitizedState(roomId);
            }
        }
    }));

    socket.on('disconnect', safe(() => {
        let roomId = socket.roomId;
        let state = rooms[roomId];
        if (state && state.players[socket.id]) {
            let p = state.players[socket.id];
            p.oldId = socket.id;
            state.offlinePlayers.push(p); 

            let isHost = (state.hostId === socket.id);
            let advanceTurn = false;

            state.seats.forEach((seat, idx) => {
                if (seat && seat.ownerId === socket.id) {
                    if (state.status === 'playing' || state.status === 'dealing' || state.status === 'dealer_turn') {
                        seat.state = 'stood';
                        if (state.status === 'playing' && state.currentSeatIndex === idx) advanceTurn = true;
                    } else {
                        state.seats[idx] = null; 
                    }
                }
            });
            delete state.players[socket.id];

            let onlineIds = Object.keys(state.players);
            if (onlineIds.length === 0) {
                if(roomTimers[roomId]) clearInterval(roomTimers[roomId]);
                delete rooms[roomId]; 
            } else {
                if (isHost) {
                    state.hostId = onlineIds[0];
                    if (state.dealerId === socket.id) {
                        state.dealerId = onlineIds[0];
                        io.to(roomId).emit('error_msg', "莊家已斷線！權限自動移交給下一位玩家。");
                    }
                }
                if (advanceTurn) nextPlayerTurn(roomId);
                else sendSanitizedState(roomId);
            }
        }
    }));
});

server.listen(3000, () => console.log('百萬級 VIP 21點伺服器啟動！'));