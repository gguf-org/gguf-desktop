/* script.js */

const board = document.getElementById('game-board');
const statusDisplay = document.getElementById('status');
const resetButton = document.getElementById('reset-button');

let boardState = ['', '', '', '', '', '', '', '', ''];
let currentPlayer = 'X';
let gameActive = true;

const winningConditions = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
];

function handleCellClick(event) {
    const clickedCell = event.target.closest('.cell');
    const clickedCellIndex = parseInt(clickedCell.dataset.index);

    if (boardState[clickedCellIndex] !== '' || !gameActive) {
        return;
    }

    // Update game state and UI
    boardState[clickedCellIndex] = currentPlayer;
    clickedCell.textContent = currentPlayer;
    clickedCell.classList.add('marked');

    // Check for game end
    if (checkForWinner()) {
        handleGameOver();
    } else if (checkForDraw()) {
        handleGameOver();
    } else {
        // Switch player
        currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
        statusDisplay.textContent = `Player ${currentPlayer}'s Turn`;
    }
}

function checkForWinner() {
    for (let i = 0; i < winningConditions.length; i++) {
        const [a, b, c] = winningConditions[i];
        if (boardState[a] === boardState[b] && boardState[b] === boardState[c] && boardState[a] !== '') {
            return true;
        }
    }
    return false;
}

function checkForDraw() {
    // Check if all cells are filled
    for (let i = 0; i < boardState.length; i++) {
        if (boardState[i] === '') {
            return false; // Not a draw yet, there's an empty spot
        }
    }
    return true; // All cells are filled, it's a draw
}

function handleGameOver() {
    gameActive = false;
    if (checkForWinner()) {
        statusDisplay.textContent = `Player ${currentPlayer} Wins! 🎉`;
    } else {
        statusDisplay.textContent = `It's a Draw! 🤝`;
    }
}

function initializeGame() {
    boardState = ['', '', '', '', '', '', '', '', ''];
    currentPlayer = 'X';
    gameActive = true;
    statusDisplay.textContent = `Player ${currentPlayer}'s Turn`;
    
    // Clear all cell content and classes
    document.querySelectorAll('.cell').forEach(cell => {
        cell.textContent = '';
        cell.classList.remove('marked');
    });
}

// Event Listeners
board.addEventListener('click', handleCellClick);
resetButton.addEventListener('click', initializeGame);

// Initialize the game on load
initializeGame();