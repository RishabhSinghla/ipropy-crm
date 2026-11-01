import { describe, expect, it } from 'vitest';
import { namesInTheSameFamily } from '../src/core/workflow/whatsappTemplateStep.js';

describe('a template and its twin count as one message', () => {
  it('marketing and utility versions are the same family', () => {
    expect(namesInTheSameFamily('ipropy_new_enquiry_details_mkt'))
      .toEqual(['ipropy_new_enquiry_details_mkt', 'ipropy_new_enquiry_details_utl']);
    expect(namesInTheSameFamily('ipropy_new_enquiry_details_utl'))
      .toEqual(['ipropy_new_enquiry_details_mkt', 'ipropy_new_enquiry_details_utl']);
  });
  it('any other name is its own family', () => {
    expect(namesInTheSameFamily('thankyou')).toEqual(['thankyou']);
  });
});
