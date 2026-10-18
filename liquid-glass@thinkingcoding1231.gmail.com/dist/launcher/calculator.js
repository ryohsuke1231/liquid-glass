// Arithmetic typed into the launcher, such as "3*8", "3*8=" or "1-5": + - * / % ^, parentheses, decimals,
// and the × ÷ − signs. Parsed by hand rather than evaluated, so nothing typed can run as code.
const OPERATORS = '+-*/%^()';

function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === ' ') {
            i++;
        }
        else if (OPERATORS.includes(c)) {
            tokens.push(c);
            i++;
        }
        else {
            const number = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
            if (!number)
                return null;
            tokens.push(number[0]);
            i += number[0].length;
        }
    }
    return tokens;
}

class Parser {
    _tokens;
    _at = 0;
    // Whether a binary operator was read: a lone number is not a calculation.
    binary = false;

    constructor(_tokens) {
        this._tokens = _tokens;
    }

    parse() {
        const value = this._sum();
        return this._at === this._tokens.length ? value : null;
    }

    _peek() {
        return this._tokens[this._at];
    }

    _sum() {
        let value = this._product();
        while (value !== null && (this._peek() === '+' || this._peek() === '-')) {
            const op = this._tokens[this._at++];
            const right = this._product();
            if (right === null)
                return null;
            this.binary = true;
            value = op === '+' ? value + right : value - right;
        }
        return value;
    }

    _product() {
        let value = this._power();
        while (value !== null && (this._peek() === '*' || this._peek() === '/' || this._peek() === '%')) {
            const op = this._tokens[this._at++];
            const right = this._power();
            if (right === null)
                return null;
            this.binary = true;
            value = op === '*' ? value * right : op === '/' ? value / right : value % right;
        }
        return value;
    }

    _power() {
        const base = this._unary();
        if (base === null || this._peek() !== '^')
            return base;
        this._at++;
        const exponent = this._power();
        if (exponent === null)
            return null;
        this.binary = true;
        return base ** exponent;
    }

    _unary() {
        const token = this._peek();
        if (token === '-' || token === '+') {
            this._at++;
            const value = this._unary();
            return value === null ? null : token === '-' ? -value : value;
        }
        if (token === '(') {
            this._at++;
            const value = this._sum();
            if (this._peek() !== ')')
                return null;
            this._at++;
            return value;
        }
        if (token === undefined || OPERATORS.includes(token))
            return null;
        this._at++;
        return Number(token);
    }
}

/** The value of `text` when it is a calculation, else null. */
export function evaluate(text) {
    const expression = text.replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').trim().replace(/=$/, '');
    const tokens = tokenize(expression);
    if (!tokens || tokens.length < 3)
        return null;
    const parser = new Parser(tokens);
    const value = parser.parse();
    return value !== null && parser.binary && Number.isFinite(value) ? value : null;
}

/** `value` with no more digits than a double holds reliably, and no exponent for everyday sizes. */
export function formatNumber(value) {
    const rounded = Number(value.toPrecision(12));
    return Object.is(rounded, -0) ? '0' : String(rounded);
}
