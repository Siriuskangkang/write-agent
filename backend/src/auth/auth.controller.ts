import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  Res,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import express from 'express';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdatePasswordDto } from './dto/update-password.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { ok } from '../common/dto/response.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: '获取当前用户信息' })
  async me(@CurrentUser() user: JwtPayload) {
    const result = await this.authService.getMe(user.sub);
    return ok(result);
  }

  @Post('register')
  @ApiOperation({ summary: '用户注册' })
  async register(@Body() dto: RegisterDto) {
    const user = await this.authService.register(dto);
    return ok(user);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '用户登录' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const user = await this.authService.login(dto, res);
    return ok(user);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新 token' })
  async refresh(
    @Req() req: express.Request,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const refreshToken = req.cookies?.['wa_refresh_token'] as
      | string
      | undefined;
    const user = await this.authService.refresh(refreshToken, res);
    return ok(user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: '退出登录' })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Req() req: express.Request,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const refreshToken = req.cookies?.['wa_refresh_token'] as
      | string
      | undefined;
    await this.authService.logout(user.sub, refreshToken);

    res.clearCookie('wa_access_token', { path: '/' });
    res.clearCookie('wa_refresh_token', { path: '/api/auth/refresh' });

    return ok(null);
  }

  @Put('password')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: '修改密码' })
  async updatePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePasswordDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    await this.authService.updatePassword(user.sub, dto);

    res.clearCookie('wa_access_token', { path: '/' });
    res.clearCookie('wa_refresh_token', { path: '/api/auth/refresh' });

    return ok(null);
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: '更新当前用户资料' })
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    const result = await this.authService.updateProfile(user.sub, dto);
    return ok(result);
  }
}
