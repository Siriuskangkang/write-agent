import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User } from './entities/user.entity.js';
import { RefreshToken } from './entities/refresh-token.entity.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdatePasswordDto } from './dto/update-password.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import type { Response } from 'express';
import type { StringValue } from 'ms';
import type { JwtPayload } from '../common/guards/auth.guard.js';

const SALT_ROUNDS = 10;

function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepo: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.userRepo.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('该邮箱已注册');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const user = this.userRepo.create({
      email: dto.email,
      password_hash: passwordHash,
      nickname: dto.nickname ?? null,
    });
    const saved = await this.userRepo.save(user);

    return { id: saved.id, email: saved.email, nickname: saved.nickname };
  }

  async login(dto: LoginDto, res: Response) {
    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    await this.issueTokens(user, res);

    return { id: user.id, email: user.email, nickname: user.nickname };
  }

  async refresh(refreshTokenRaw: string | undefined, res: Response) {
    if (!refreshTokenRaw) {
      throw new UnauthorizedException('缺少 refresh token');
    }

    const tokenHash = this.hashToken(refreshTokenRaw);
    const record = await this.refreshTokenRepo.findOne({
      where: { token_hash: tokenHash, revoked_at: IsNull() },
    });

    if (!record || record.expires_at < new Date()) {
      throw new UnauthorizedException('refresh token 无效或已过期');
    }

    // 撤销旧 token
    record.revoked_at = new Date();
    await this.refreshTokenRepo.save(record);

    const user = await this.userRepo.findOneOrFail({
      where: { id: record.user_id },
    });
    await this.issueTokens(user, res);

    return { id: user.id, email: user.email, nickname: user.nickname };
  }

  async logout(userId: string, refreshTokenRaw: string | undefined) {
    if (refreshTokenRaw) {
      const tokenHash = this.hashToken(refreshTokenRaw);
      await this.refreshTokenRepo.update(
        { user_id: userId, token_hash: tokenHash, revoked_at: IsNull() },
        { revoked_at: new Date() },
      );
    }
  }

  async updatePassword(userId: string, dto: UpdatePasswordDto) {
    const user = await this.userRepo.findOneOrFail({ where: { id: userId } });

    const valid = await bcrypt.compare(dto.old_password, user.password_hash);
    if (!valid) {
      throw new BadRequestException('原密码错误');
    }

    const newHash = await bcrypt.hash(dto.new_password, SALT_ROUNDS);
    user.password_hash = newHash;
    await this.userRepo.save(user);

    // 撤销该用户所有 refresh token
    await this.refreshTokenRepo.update(
      { user_id: userId, revoked_at: IsNull() },
      { revoked_at: new Date() },
    );
  }

  async getMe(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return { id: user.id, email: user.email, nickname: user.nickname };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    user.nickname = dto.nickname?.trim() || null;
    const saved = await this.userRepo.save(user);
    return { id: saved.id, email: saved.email, nickname: saved.nickname };
  }

  private async issueTokens(user: User, res: Response) {
    const accessTokenExpires = this.configService.get<string>(
      'JWT_EXPIRES_IN',
      '15m',
    );
    const refreshTokenExpires = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    );
    const refreshTokenMs = parseDurationToMs(refreshTokenExpires);

    const payload: JwtPayload = { sub: user.id, email: user.email };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: accessTokenExpires as StringValue,
    });

    const rawRefreshToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawRefreshToken);

    const refreshToken = this.refreshTokenRepo.create({
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + refreshTokenMs),
    });
    await this.refreshTokenRepo.save(refreshToken);

    const isProduction = this.configService.get('NODE_ENV') === 'production';

    res.cookie('wa_access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: parseDurationToMs(accessTokenExpires),
    });

    res.cookie('wa_refresh_token', rawRefreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/api/auth/refresh',
      maxAge: refreshTokenMs,
    });
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
