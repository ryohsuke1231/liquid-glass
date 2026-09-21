// A straightforward mathematical implementation of Hooke's Law for spring physics
export class Spring {
    stiffness;
    damping;
    mass;
    value;
    velocity;
    target;
    constructor(stiffness, damping, mass) {
        this.stiffness = stiffness;
        this.damping = damping;
        this.mass = mass;
        this.value = 0;
        this.velocity = 0;
        this.target = 0;
    }
    updateParams(stiffness, damping, mass) {
        this.stiffness = stiffness;
        this.damping = damping;
        this.mass = mass;
    }
    update(elapsedMs) {
        let dt = elapsedMs / 1000;
        if (dt > 0.033)
            dt = 0.033;
        let springForce = -this.stiffness * (this.value - this.target);
        let dampingForce = -this.damping * this.velocity;
        let acceleration = (springForce + dampingForce) / this.mass;
        this.velocity += acceleration * dt;
        this.value += this.velocity * dt;
        return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
    }
}
export class SwiftSpring {
    response;
    dampingFraction;
    mass;
    value;
    velocity;
    target;
    constructor(response, dampingFraction, mass = 1.0) {
        this.response = typeof response === 'number' && !isNaN(response) && response > 0.01 ? response : 0.4;
        this.dampingFraction = typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0 ? dampingFraction : 0.7;
        this.mass = typeof mass === 'number' && !isNaN(mass) && mass > 0.01 ? mass : 1.0;
        this.value = 0;
        this.velocity = 0;
        this.target = 0;
    }
    updateParams(response, dampingFraction, mass = 1.0) {
        if (typeof response === 'number' && !isNaN(response) && response > 0.01)
            this.response = response;
        if (typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0)
            this.dampingFraction = dampingFraction;
        if (typeof mass === 'number' && !isNaN(mass) && mass > 0.01)
            this.mass = mass;
    }
    update(elapsedMs) {
        let dt = elapsedMs / 1000;
        if (isNaN(dt) || dt <= 0)
            return false;
        if (dt > 0.1)
            dt = 0.1;
        if (isNaN(this.value) || !isFinite(this.value) || isNaN(this.velocity) || !isFinite(this.velocity)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const x0 = this.value - this.target;
        const v0 = this.velocity;
        if (Math.abs(x0) < 0.001 && Math.abs(v0) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const omega0 = (2 * Math.PI) / this.response;
        const zeta = this.dampingFraction;
        let x_t = 0;
        let v_t = 0;
        // Analytical solution — no numerical explosion regardless of spring stiffness
        if (zeta < 0.999) {
            // 1. Underdamped — standard bouncy motion
            const omegaD = omega0 * Math.sqrt(1.0 - zeta * zeta);
            const alpha = zeta * omega0;
            const exp = Math.exp(-alpha * dt);
            const cos = Math.cos(omegaD * dt);
            const sin = Math.sin(omegaD * dt);
            x_t = exp * (x0 * cos + ((v0 + alpha * x0) / omegaD) * sin);
            v_t = exp * (v0 * cos - ((alpha * v0 + omega0 * omega0 * x0) / omegaD) * sin);
        }
        else if (zeta > 1.001) {
            // 2. Overdamped — slow, viscous motion
            const beta = omega0 * Math.sqrt(zeta * zeta - 1.0);
            const gamma1 = -zeta * omega0 + beta;
            const gamma2 = -zeta * omega0 - beta;
            const exp1 = Math.exp(gamma1 * dt);
            const exp2 = Math.exp(gamma2 * dt);
            const c1 = (v0 - gamma2 * x0) / (gamma1 - gamma2);
            const c2 = x0 - c1;
            x_t = c1 * exp1 + c2 * exp2;
            v_t = c1 * gamma1 * exp1 + c2 * gamma2 * exp2;
        }
        else {
            // 3. Critically damped — fastest settle without overshoot
            const exp = Math.exp(-omega0 * dt);
            x_t = exp * (x0 + (v0 + omega0 * x0) * dt);
            v_t = exp * (v0 - omega0 * (v0 + omega0 * x0) * dt);
        }
        this.value = x_t + this.target;
        this.velocity = v_t;
        if (isNaN(this.value) || !isFinite(this.value)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        this.value = Math.max(-0.5, Math.min(2.5, this.value));
        if (Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        return false;
    }
}
