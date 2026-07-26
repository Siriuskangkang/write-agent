import { validate } from 'class-validator';
import { LoginDto } from './login.dto';

describe('LoginDto', () => {
  it('accepts a local login email without a top-level domain', async () => {
    const dto = Object.assign(new LoginDto(), {
      email: 'admin@admin',
      password: '123456',
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
